# test-share

Stops parallel `vitest` and `tsc` runs from oversubscribing this Mac, without a fixed worker cap and without touching any project.

One file, `preload.cjs`, is loaded into every node process through `NODE_OPTIONS`. It does two things:

- **Budget.** All `vitest` runs together may use `floor(cores * 0.8)` workers: 12 of this Mac's 15 cores, so the CPU is used but not filled. Each run registers itself in `~/.cache/test-share/runs/<pid>` with the workers it took. A new run gets `max(MIN, min(floor(BUDGET / active runs), BUDGET - workers already claimed))`. Alone: 12. Two started together: 6 each. Four started together: 3 each.
- **Priority.** `vitest` and `tsc` (also `vue-tsc`) are set to nice 10, and their workers inherit it, so interactive apps go first.

Every other node process (npm, vite, vitest's own workers, scripts) leaves after one string check: about 0.3 ms.

## Switch on

Add to the `env` block of `~/.claude/settings.json`:

```json
"NODE_OPTIONS": "--require /Users/casandra/Code/Personal/test-share/preload.cjs"
```

For one shell: `export NODE_OPTIONS="--require /Users/casandra/Code/Personal/test-share/preload.cjs"`.

## Switch off

- One command or shell: `TEST_SHARE=0`.
- Everywhere: remove the `NODE_OPTIONS` line.

## Knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `TEST_SHARE=0` | on | Disables everything. |
| `TEST_SHARE_BUDGET` | `floor(cores * 0.8)` = 12 | Total vitest workers across all runs, as a number. |
| `TEST_SHARE_MIN` | `2` | Smallest share a run is given, also when the budget is used up. |
| `TEST_SHARE_NICE` | `10` | Nice value for vitest and tsc. `0` leaves priority alone. |
| `TEST_SHARE_DEBUG=1` | silent | One stderr line per target saying what was decided. |
| `TEST_SHARE_DIR` | `~/.cache/test-share/runs` | Registry folder. |

A worker count the caller chose always wins: `VITEST_MAX_THREADS`, `VITEST_MAX_FORKS` or `VITEST_MAX_WORKERS` already in the environment are left as they are, and so is a run with `--maxWorkers`, `--poolOptions.*.max*`, or `--no-file-parallelism` on the command line. That number is recorded as the run's claim, so later runs get what is left of the budget.

A literal worker limit in the project's `vitest.config.*` or `vite.config.*` (for example `maxWorkers: '50%'`) is kept when it is lower than the share: the run takes the lower number and claims only that. Where the file holds several limits, the highest is used.

## Status

```
./status
```

Shows the budget, the workers claimed and free, each run's share, and what a run started now would get.

## How the share reaches vitest

The preload sets `VITEST_MAX_THREADS`, `VITEST_MAX_FORKS` (read by vitest 3.x, together with the matching `VITEST_MIN_*`, because 3.x throws when a min is above the max) and `VITEST_MAX_WORKERS` (read by 4.x and later). Vitest reads them when it resolves its config, after the preload has run. Checked against 3.2.7 and 5.0.5.

## Watch mode

A watch run (`vitest`, `vitest watch`, `--watch` on a terminal) is registered and niced, but claims nothing from the budget, is not capped and is not counted by other runs. It lives for hours and sits idle most of that time, so holding part of the budget for it would starve every other run while it does nothing. It keeps vitest's own watch default, half the cores (7), so while a watch run is re-running tests next to a full budget the total can pass the budget by up to 7.

## Known limits

- **A run keeps the worker count it started with, and a late run still gets MIN.** A run that starts while the budget is used up is given `TEST_SHARE_MIN` (2) workers and not made to wait, so the total passes the budget by 2 for each such run: one run then three more a second apart hold 12 + 2 + 2 + 2 = 18 until the first finishes. The first run does not shrink, and a late run does not grow when the first one ends.
- **Runs started in the same instant** agree on an order through the registry and split the budget evenly. This is not a lock: under heavy load two of them can still read the registry at the wrong moment and take more than their part.
- **The config limit is read as text.** The `VITEST_MAX_*` variables win over the config file in vitest, so a limit the preload cannot read (computed, imported, or in a config outside the working folder and not named with `--config`) is replaced by the share.
- **Only `vitest` started from its CLI is shared.** Vitest started from a script through its node API, jest, playwright and other runners are not seen.
- **A script that sets its own `NODE_OPTIONS`** replaces this one, so the preload is absent for it. Nothing breaks; that command is just not shared or niced. To keep both: `NODE_OPTIONS="--max-old-space-size=4096 $NODE_OPTIONS"`.
- **Nice lowers priority; it does not move work to efficiency cores** or limit memory.
- **`kill -9` leaves a registry entry behind.** It is ignored at once (the pid is dead) and deleted by the next run. An entry whose pid is alive but which has not been touched for 5 minutes is dropped too (live runs touch theirs every 30 seconds).
- A priority already lower than `TEST_SHARE_NICE` is left alone.
