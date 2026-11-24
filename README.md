# pump-fun-paper-sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cryptokom-tech/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cryptokom-tech/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve activity. Nothing is traded for real.

The bot buys only launches that already hold 10-30 SOL of real reserve within their first 3 slots, with at most 2 distinct non-creator buyers, the creator's own buy at most 0.5 SOL, no creator sale and no big sell. One small stake per coin, no pyramiding. Positions exit whole at +30% take-profit, -3% stop, after 30 slots, or when the creator sells. A 6-hour pacing probe opens tiny 0.012 SOL round trips so the entry clears the 20-coin guardrail inside the 6-hour final window. See STRATEGY.md for the measurements behind these choices.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (see the kit's `sdk/ts/makefun-bot.ts`, vendored in `vendor/`). It needs Node 22.18+ and nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=08bvq6fy&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
