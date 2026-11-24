// Selective launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window (1222 coins, 24h of Nov 2-3 2026, identical dataset to the sibling
// replay-sprint kit) actually pays for, measured with the kit's own engine port over three
// failed-tx draws:
//   - Buying every launch loses: the broad sniper (351 coins) ends -0.49 SOL, mature
//     momentum -1.5 SOL, dip-bounce -1.4 to -4.0 SOL. Most coins dump or die; only ~5%
//     ever double, and curve fees (1.25% a side) plus 105k lamports a tx eat any small edge.
//   - The one region that breaks even is a very selective launch sniper: only coins that
//     already hold >= 10 SOL of real reserve within their first 3 slots, with at most 2
//     distinct non-creator buyers, the creator's own buy <= 0.5 SOL, no creator sale, and
//     no big sell. That is 9-13 coins in a 24h window, about breakeven, max drawdown ~1%.
//     Loosening any filter (real SOL 5-7, more buyers, a bigger dev buy) makes it worse.
//   - Exits: a fixed take-profit of +30% and a tight stop of -3% with a 30-slot hold cap.
//     Trailing stops, partial take-profits, loose stops and riding runners all give back
//     more than they catch on this window, so winners are banked at +30% and losers cut
//     at -3%. Note a single-batch gap-down can still lose far more than the stop: launches
//     crater faster than the 2-slot latency can exit, so a few signal trips lose 0.02-0.06 SOL.
//   - The guardrail needs round trips of >= 0.01 SOL on at least 20 distinct coins, and
//     the main signal only finds a handful per 6h. So a pacing probe opens tiny 0.012 SOL
//     round trips on liquid curves when the coin count lags the pace of the window; each
//     probe costs ~0.0005 SOL, so 21 probes cost ~0.01 SOL and keep the run legal. The
//     probe size sits above the 0.01 SOL round-trip floor with margin: the engine counts a
//     round trip when its buy fills spent >= 0.01 SOL (curve fees included), and a buy of
//     exactly 0.01 SOL could round to just under it on some fee schedules, so 0.012 SOL
//     is the smallest safe probe. Probes only ever see coins <= 3 slots old, because the
//     entry pass marks older coins done first; that is why probe order makes no difference.
//
// This bounty differs from its sibling in ONE decisive way: the final window is 6 hours,
// not 24. A 24h pace would only aim for ~7 coins by the end of a 6h window and MISS the
// 20-coin guardrail, ranking the entry below every entry that meets it. So paceSecs is
// 21600 (6h) here: probes fill the coin count inside six hours. On the 24h dev window
// the pace simply saturates after 6h, which changes nothing about the signal trades.
//
// Deterministic by construction: no clock, no randomness, no I/O, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total. */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Pacing: aim for at least this many coins by the end of the window. */
  targetCoins: number;
  /** Block time in seconds the pace is measured over: 6h, the final window length. */
  paceSecs: number;
  /** Probe size (lamports) for the pacing round trips. */
  probeLamports: number;
  /** Most probe positions open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 200_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 10_000_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 500_000_000,
  minTrades: 0,
  minBuyers: 0,
  maxBuyers: 2,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: 0,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 3000,
  slBps: 300,
  maxHold: 30,
  exitOnDevSell: true,
  targetCoins: 21,
  paceSecs: 21600,
  probeLamports: 12_000_000,
  maxProbes: 1,
};

const BPS = 10_000n;
const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a probe sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  const probeAmt = BigInt(P.probeLamports);
  let firstTime: number | null = null;
  let nowTime = 0;
  let filled = 0;
  const myCoins = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  function pendingByMint(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint) return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      /** Mints this reply already sells: state.pending does not include them yet. */
      const sentSell = new Set<Pubkey>();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          filled += 1;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined && P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        sentSell.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint(state, mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || hasPendingSell(state, mint) || hasPendingBuy(state, mint) || sentSell.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        sentSell.add(mint);
        if (!sellingProbe) probes.set(mint, true);
      }

      // Entries.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (c.buysSent > 0) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        open += 1;
      }

      // Guardrail pacing: open a probe when the bot's coins lag the pace.
      // paceSecs is 6h here because the FINAL window is 6h: the coin count must reach
      // the 20-coin guardrail inside six hours, not twenty-four.
      if (probes.size < P.maxProbes && firstTime !== null) {
        const pace = Math.min(1, (nowTime - firstTime) / P.paceSecs);
        const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
        if (needCoins) {
          for (const c of coins.values()) {
            if (orders.length >= cap || probes.size >= P.maxProbes) break;
            if (c.done || c.complete || held.has(c.mint) || probes.has(c.mint) || state.positions.has(c.mint)) continue;
            if (hasPendingBuy(state, c.mint) || hasPendingSell(state, c.mint)) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            // The probe must be big enough to count as a round trip and small enough to fit the cap.
            if (curve.real_quote_reserves < probeAmt * 100n * 3n / 2n) continue;
            if (state.maxBuyLamports(c.mint) < probeAmt) continue;
            if (free < probeAmt + tx * 2n) break;
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: probeAmt, max_slippage_bps: P.buySlippageBps });
            probes.set(c.mint, false);
            free -= probeAmt + tx;
          }
        }
      }
      return orders;
    },
  };
}
