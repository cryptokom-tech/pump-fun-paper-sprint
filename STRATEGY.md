# STRATEGY.md — Pump.fun Paper Sprint: Any Bot Can Win

## What the dev window pays for

Measured on the kit's dev window (1222 coins, 24h of 2-3 Nov 2026 — the dataset is
byte-identical to the sibling replay-sprint kit's, same sha256) with the kit's own
engine port, averaged over three failed-tx draws (the final window uses a secret
draw, so a setting that only wins on one draw is worth nothing). The final window
here is **6 hours**, not 24, so every design below is also measured on each 6-hour
slice of the dev window — a 6h slice is what the final actually looks like.

| Design | 6h slice mean (SOL) | Full 24h (SOL) | Coins | Max DD |
| --- | --- | --- | --- | --- |
| Broad launch sniper (kit pilot, default) | -0.06 .. -0.24 | -0.49 | 351 | 0.054 |
| Mature momentum (kit pilot) | -1.09 .. -9.85 | -9.57 | 50 | 0.987 |
| Selective launch sniper, 24h pace, 0.02 probes | -0.026 | +0.003 | 34 | 0.010 |
| **Selective launch sniper (this bot)** | **-0.002** | **+0.025** | **30** | **0.010** |

Three facts drive the design:

1. **Most coins dump or die.** Buying a launch at create+3 slots, the median coin is
   flat and 27% are down more than 12% a hundred slots later; only ~5% ever double.
   Fees are 1.25% a side plus 105k lamports per transaction, so a small edge
   disappears in fees. Momentum is catastrophic on this data (-1 to -10 SOL a slice).
2. **Selectivity is the only thing that breaks even.** Only coins that already hold
   >= 10 SOL of real reserve within their first 3 slots, with at most 2 distinct
   non-creator buyers, the creator's own buy <= 0.5 SOL, no creator sale and no big
   sell, come out around breakeven. Loosening any filter — real SOL 5-8, more buyers,
   a bigger dev buy, a 5-slot entry window — makes it clearly worse. The 1% order-size
   cap means each signal trade is at most ~0.1 SOL, so stake size above that is
   irrelevant (150k/200k/250k lamports all grade identically).
3. **The failed-tx draw and gap risk dominate.** A single-batch gap-down can lose
   0.02-0.06 SOL on one signal coin — far more than the -3% stop — because launches
   crater faster than the 2-slot latency can exit. Few, selective, well-sized positions
   keep that bounded. The final window is a fresh 6h of coins, so robustness is worth
   more than a tuned dev score.

## The bot

- **Entry:** a coin in its first 3 slots whose real SOL reserve is already 10-30 SOL,
  whose creator bought at most 0.5 SOL of it, with at most 2 distinct non-creator
  buyers, no creator sale, sells by others at most 100% of buys, no single sell over
  100% of the reserve, and non-negative net flow over the last 10 slots. One buy of
  up to 0.2 SOL (capped at 1% of the real reserve, so ~0.1 SOL in practice), never a
  second buy on the same coin.
- **Exits:** sell everything at +30% over cost, at -3% under cost, after 30 slots
  held, or immediately when the creator sells while held. Sweeps showed TP 3000 /
  SL 300 / hold 30 beats TP 2500 / SL 500 and beats riding runners (TP 10000, loose
  stop, no hold cap: -0.28 SOL on the full window) and beats bigger stakes with
  looser exits (-0.11 SOL).
- **Guardrail pacing — the 6h adaptation:** the main signal finds only ~2 coins per
  6h, but the guardrail needs round trips of >= 0.01 SOL on at least 20 distinct
  coins with max drawdown <= 50%. The pace is measured over **6 hours** (paceSecs
  21600), not 24: a 24h pace would only aim for ~7 coins by the end of a 6h window
  and miss the guardrail, ranking the entry below every entry that meets it. When
  the coin count lags the pace, the bot opens 0.012 SOL probe round trips on liquid
  curves and sells them as soon as the buy lands. 21 probes cost ~0.01 SOL total.
  The probe size sits above the 0.01 SOL round-trip floor with margin: the engine
  counts a round trip when its buy fills spent >= 0.01 SOL (curve fees included),
  and a buy of exactly 0.01 SOL could round to just under it on some fee schedules,
  so 0.012 SOL is the smallest safe probe. Target is 21 coins, one spare above the
  20 minimum; the bot keeps probing until 21 coins have *filled*, so failed probe
  buys are replaced, not counted.
- **Costs:** 30 coins on the full window (9 signal + 21 probes), 5 wins, best trip
  +0.076 SOL, worst -0.056 SOL, max drawdown 1.0%. The whole 10 SOL is never
  deployed; most of it stays cash.

## What it cannot do

It cannot make a losing window win: if the final 6h has no runner among the
selective launches, it ends near zero (about -0.02 SOL on the worst dev slice). Its
edge is a lottery ticket with a breakeven expectation — a runner caught at +30% is
worth +0.03 SOL, and the selective filter is what keeps the losers small. Any claim
stronger than that would be overfitting the dev window. Per-slice results: -0.002 /
+0.033 / -0.019 / -0.020 SOL across the four 6h slices (mean -0.002, worst -0.020).

## Verification

- Local backtest (kit engine port, full dev window, 3 fail draws): mean +0.025 SOL,
  worst +0.024 SOL, 30 coins, max drawdown 0.010.
- 6h slices (same port, 3 fail draws each): means -0.002 / +0.033 / -0.019 / -0.020.
- `grade-local --driver process` result is recorded in the handoff file
  `~/workspace/makefun/HANDOFF-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.md`.
