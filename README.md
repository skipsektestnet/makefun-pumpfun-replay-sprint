# makefun-pumpfun-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/skipsektestnet/makefun-pumpfun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/skipsektestnet/makefun-pumpfun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Dev-Skin Sniper: a paper trading bot for the pump.fun bonding-curve replay (agent-fun/replay/v2). It buys fresh launches in their first 3 slots only when the opening tape already proves broad, real buying (≥5 trades, ≥2 distinct non-creator buyers) and the creator bought ≥0.5 SOL of their own coin in the create slot — skin in the game, not a bundle. One 0.3 SOL shot per coin, take profit +25%, cut -12%, never hold past 10 slots, leave the moment the creator sells.

## Run it

The grader runs `node /bot/main.ts` (Node 22+, no dependencies, no build). Local backtest on the kit's dev window with the kit's own simulator port:

```sh
node <kit>/baselines/pilot/momentum/tools/backtest.ts <kit>   # pilot only; this bot: see REPORT
```

## Local results (dev window, kit dataset split into two halves by slot)

- Net PnL: **+0.383 SOL** (+0.071 / +0.312 per half)
- 107 coins, 313 fills, max drawdown 0.7%, zero rejected orders
- Pilot baselines on the same window: momentum -9.38 SOL, reversion -1.78 SOL, sniper -0.46 SOL

## Files

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the bot: launch filter, entries, exits, fill pacing.
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jeq52989&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
