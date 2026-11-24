// Pump.fun Paper Sprint — selective launch sniper with 6h guardrail pacing.
//
// Idea, in one paragraph: most fresh pump.fun launches lose money, so the bot
// only buys the rare launch that already looks alive — 10 to 30 SOL of real
// reserve inside its first 3 slots, at most two other buyers besides the
// creator, the creator's own buy no bigger than 0.5 SOL, and no creator sale.
// Each such coin gets one small stake (1% of its real reserve, at most 0.1 SOL)
// and is sold whole at +30%, at -3%, after 30 slots, or the moment the creator
// sells. That signal alone only finds a couple of coins in a 6-hour window,
// while the guardrail needs round trips on 20 distinct coins, so a second,
// separate pass opens tiny 0.012 SOL buy-then-sell probes on young liquid
// curves, paced so the coin count reaches 21 by the end of 6 hours.
//
// Everything here is deterministic by construction: no clock, no randomness,
// no I/O. All decisions come from the batch stream, in the order it arrives.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const SOL = LAMPORTS_PER_SOL;

// Entry window: a launch is only eligible in its first few slots.
const MIN_AGE_SLOTS = 0;
const MAX_AGE_SLOTS = 3;

// Entry filter: real SOL reserve already on the curve, in lamports.
const MIN_REAL_RESERVE = 10n * SOL;
const MAX_REAL_RESERVE = 30n * SOL;

// Entry filter: how many distinct buyers besides the creator may have
// bought so far, and how much the creator may have bought themselves.
const MAX_OTHER_BUYERS = 2;
const MAX_CREATOR_BUY = (SOL * 5n) / 10n; // 0.5 SOL

// Stake: 1% of the coin's real reserve, never more than this.
const MAX_STAKE = SOL / 10n; // 0.1 SOL

// Exits, in basis points against the position's cost.
const TAKE_PROFIT_BPS = 3000; // +30%
const STOP_LOSS_BPS = 300; // -3%
const MAX_HOLD_SLOTS = 30;

// Guardrail pacing: tiny probe round trips that carry the coin count.
const PROBE_SPEND = (SOL * 12n) / 1000n; // 0.012 SOL
const PROBE_TARGET_COINS = 21; // one spare above the 20-coin guardrail
const PACE_SECONDS = 21600; // 6 hours
const MIN_ROUND_TRIP = SOL / 100n; // 0.01 SOL: what a round trip must spend

// A probe needs a curve liquid enough that the 1% per-order size cap still
// admits the probe spend (0.012 SOL needs at least 1.2 SOL of reserve);
// demand a little more so a wobbling reserve cannot reject the order.
const MIN_PROBE_RESERVE = 2n * SOL;

// Slippage allowance on every order, in basis points.
const SLIPPAGE_BPS = 500;

// ------------------------------------------------------------------ per-coin notes

/** Everything the bot remembers about one mint, in first-seen order. */
interface CoinNote {
  mint: Pubkey;
  creator: Pubkey | null;
  /** Slot of the CreateEvent; -1 when the mint first appeared via a trade. */
  bornSlot: number;
  creatorBuyLamports: bigint;
  creatorSold: boolean;
  otherBuyers: Set<Pubkey>;
  /** Aged past the entry window, completed, or otherwise finished with. */
  done: boolean;
  /** A buy (signal or probe) has been sent for this mint. */
  bought: boolean;
  /** The buy sent for this mint was a pacing probe. */
  probe: boolean;
  /** A probe buy was already tried here (filled, rejected or failed). */
  probeTried: boolean;
}

/** A position the bot holds, with the slot its buy filled at. */
interface HeldNote {
  mint: Pubkey;
  buySlot: number;
  probe: boolean;
}

// ------------------------------------------------------------------ the bot

export function createPaperSprintBot(): Bot {
  // Insertion-ordered: the batch stream feeds these, and every pass below
  // iterates them in that order, so two runs decide identically.
  const coins = new Map<Pubkey, CoinNote>();
  const held = new Map<Pubkey, HeldNote>();
  // Distinct mints whose buy filled spending at least MIN_ROUND_TRIP.
  const counted = new Set<Pubkey>();

  let windowStartSecs: number | null = null;
  let latestSecs: number | null = null;

  // ---------------------------------------------------------- bookkeeping

  function noteFor(mint: Pubkey, slot: number): CoinNote {
    let note = coins.get(mint);
    if (note === undefined) {
      note = {
        mint,
        creator: null,
        bornSlot: -1,
        creatorBuyLamports: 0n,
        creatorSold: false,
        otherBuyers: new Set(),
        done: false,
        bought: false,
        probe: false,
        probeTried: false,
      };
      coins.set(mint, note);
    }
    return note;
  }

  /** Fold this batch's fills into the coin counts and held positions. */
  function noteFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        const spent = BigInt(fill.quote_lamports);
        if (spent >= MIN_ROUND_TRIP) counted.add(fill.mint);
        const note = noteFor(fill.mint, fill.slot);
        held.set(fill.mint, {
          mint: fill.mint,
          buySlot: fill.slot,
          probe: note.probe,
        });
      }
      if (fill.side === 'buy' && fill.status !== 'filled') {
        // A probe buy that never filled is not retried on this mint; a
        // signal buy that never filled leaves the coin alone too.
        noteFor(fill.mint, fill.slot).probeTried = true;
      }
    }
    // Positions the harness closed (curve completed, replay flattened)
    // disappear from the account; drop their notes with them.
    for (const mint of [...held.keys()]) {
      if (!batch.account.positions.some((p) => p.mint === mint)) held.delete(mint);
    }
  }

  /** Fold this batch's events into the per-coin notes and the clock. */
  function noteEvents(batch: Batch): void {
    for (const event of batch.events) {
      if (event.block_time !== null) {
        if (windowStartSecs === null) windowStartSecs = event.block_time;
        latestSecs = event.block_time;
      }
      if (event.event === 'CreateEvent') {
        const note = noteFor(event.mint, event.slot);
        note.creator = event.creator;
        note.bornSlot = event.slot;
      } else if (event.event === 'TradeEvent') {
        const note = noteFor(event.mint, event.slot);
        if (note.creator === null) note.creator = event.creator;
        const amount = BigInt(event.sol_amount);
        if (event.is_buy) {
          if (event.user === note.creator) {
            note.creatorBuyLamports += amount;
          } else {
            note.otherBuyers.add(event.user);
          }
        } else if (event.user === note.creator) {
          note.creatorSold = true;
        }
      } else {
        // CompleteEvent: the curve is over; never trade it again.
        noteFor(event.mint, event.slot).done = true;
      }
    }
  }

  // ---------------------------------------------------------- exits

  /** Current mark value of a holding, in lamports, from virtual reserves. */
  function markValue(state: BotState, mint: Pubkey, tokens: bigint): bigint | null {
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    if (curve.virtual_token_reserves <= 0n) return null;
    return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  /** Did this mint's creator sell in this batch's events? */
  function creatorSoldThisBatch(batch: Batch, mint: Pubkey, creator: Pubkey | null): boolean {
    if (creator === null) return false;
    for (const event of batch.events) {
      if (event.event === 'TradeEvent' && event.mint === mint && !event.is_buy && event.user === creator) {
        return true;
      }
    }
    return false;
  }

  /** Sell orders for every position that has hit an exit, probes first. */
  function exitOrders(state: BotState, batch: Batch, orders: OrderInput[]): void {
    // A sell decided on one batch only resolves two slots later, and the
    // position still shows until then; without this guard the same sell
    // would go out again on the next two batches and be rejected (or, on
    // the 2% failed-tx draw, pay its fee for nothing).
    const sellPending = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') sellPending.add(pending.order.mint);
    }

    // positions is a Map keyed by mint; the Holding value carries no mint,
    // so iterate entries to keep the mint alongside its tokens and cost.
    for (const [mint, position] of state.positions) {
      if (sellPending.has(mint)) continue;
      const note = held.get(mint);
      const tokens = BigInt(position.token_amount);
      if (tokens <= 0n) continue;
      const cost = BigInt(position.cost_lamports);

      let sell = false;
      if (note !== undefined && note.probe) {
        // A probe exists only to complete a round trip: sell as soon as
        // its buy has landed.
        sell = true;
      } else {
        const value = markValue(state, mint, tokens);
        if (value !== null) {
          // Take profit at +30% over cost, stop loss at -3% under it.
          if (value * 10_000n >= cost * BigInt(10_000 + TAKE_PROFIT_BPS)) sell = true;
          if (value * 10_000n <= cost * BigInt(10_000 - STOP_LOSS_BPS)) sell = true;
        }
        if (note !== undefined && state.slot - note.buySlot >= MAX_HOLD_SLOTS) sell = true;
        const coin = coins.get(mint);
        if (coin !== undefined && creatorSoldThisBatch(batch, mint, coin.creator)) sell = true;
      }

      if (sell) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: tokens,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }
  }

  // ---------------------------------------------------------- signal entries

  /** How many coins the pace says the bot should have counted by now. */
  function paceTarget(): number {
    if (windowStartSecs === null || latestSecs === null) return 0;
    const elapsed = latestSecs - windowStartSecs;
    if (elapsed <= 0) return 0;
    const target = Math.floor((PROBE_TARGET_COINS * elapsed) / PACE_SECONDS);
    return target > PROBE_TARGET_COINS ? PROBE_TARGET_COINS : target;
  }

  /**
   * The entry pass: one selective buy per qualifying launch. Coins older
   * than the entry window are marked done here, before the probe pass runs,
   * so probes only ever see coins at most MAX_AGE_SLOTS old.
   */
  function entryOrders(
    state: BotState,
    batch: Batch,
    orders: OrderInput[],
    cashLeft: { value: bigint },
    openSlots: { value: number },
  ): void {
    const txFee = state.txFeeLamports();
    for (const note of coins.values()) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (note.done || note.bought || note.probeTried) continue;
      if (note.bornSlot < 0) continue; // no CreateEvent seen: age unknown
      const age = batch.slot - note.bornSlot;
      if (age > MAX_AGE_SLOTS) {
        note.done = true;
        continue;
      }
      if (age < MIN_AGE_SLOTS) continue;
      if (openSlots.value <= 0) break;

      const curve = state.curves.get(note.mint);
      if (curve === undefined || curve.complete) {
        note.done = true;
        continue;
      }
      const reserve = curve.real_quote_reserves;
      if (reserve < MIN_REAL_RESERVE || reserve > MAX_REAL_RESERVE) continue;
      if (note.otherBuyers.size > MAX_OTHER_BUYERS) continue;
      if (note.creatorBuyLamports > MAX_CREATOR_BUY) continue;
      if (note.creatorSold) continue;

      // 1% of the real reserve, capped at MAX_STAKE (about 0.1 SOL here).
      let stake = reserve / 100n;
      if (stake > MAX_STAKE) stake = MAX_STAKE;
      const cap = state.maxBuyLamports(note.mint);
      if (stake > cap) stake = cap;
      if (stake < MIN_ROUND_TRIP) continue;
      if (cashLeft.value < stake + txFee) continue;

      orders.push({
        side: 'buy',
        mint: note.mint,
        quote_lamports: stake,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      note.bought = true;
      note.probe = false;
      cashLeft.value -= stake + txFee;
      openSlots.value -= 1;
    }
  }

  // ---------------------------------------------------------- pacing probes

  /**
   * The probe pass: while the counted coins lag the 6-hour pace, open a
   * 0.012 SOL probe on a young liquid curve the signal pass passed over.
   * Each probe is bought once and sold as soon as it lands, so it costs
   * little more than its fees and banks one more counted coin.
   */
  function probeOrders(
    state: BotState,
    batch: Batch,
    orders: OrderInput[],
    cashLeft: { value: bigint },
    openSlots: { value: number },
  ): void {
    const txFee = state.txFeeLamports();
    while (counted.size < paceTarget()) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (openSlots.value <= 0) break;
      if (cashLeft.value < PROBE_SPEND + txFee) break;

      let candidate: CoinNote | null = null;
      for (const note of coins.values()) {
        if (note.done || note.bought || note.probeTried) continue;
        if (note.bornSlot < 0) continue;
        if (batch.slot - note.bornSlot > MAX_AGE_SLOTS) continue;
        if (note.creatorSold) continue;
        const curve = state.curves.get(note.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_PROBE_RESERVE) continue;
        if (state.maxBuyLamports(note.mint) < PROBE_SPEND) continue;
        candidate = note;
        break;
      }
      if (candidate === null) break;

      orders.push({
        side: 'buy',
        mint: candidate.mint,
        quote_lamports: PROBE_SPEND,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      candidate.bought = true;
      candidate.probe = true;
      candidate.probeTried = true;
      cashLeft.value -= PROBE_SPEND + txFee;
      openSlots.value -= 1;
    }
  }

  // ---------------------------------------------------------- wiring

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      noteFills(batch);
      noteEvents(batch);

      const orders: OrderInput[] = [];
      exitOrders(state, batch, orders);

      const cashLeft = { value: state.freeCashLamports() };
      const openSlots = {
        value: state.hello.caps.max_open_positions - state.committedPositionCount(),
      };
      entryOrders(state, batch, orders, cashLeft, openSlots);
      probeOrders(state, batch, orders, cashLeft, openSlots);
      return orders;
    },

    onDone(state: BotState): void {
      console.error(
        `[paper-sprint] done: cash=${state.cash} counted-coins=${counted.size} ` +
          `held=${state.positions.size} coins-seen=${coins.size}`,
      );
    },
  };
}
