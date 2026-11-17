# agent-cpu-budget-protocol

Keeps test runs inside a CPU budget. When several Claude agents run `vitest` and `tsc` at once on this Mac, it shares a fixed number of test workers between them, makes late runs wait for a free share, and runs them at low priority, so the machine is used but never overloaded. No project is touched.

Formerly called test-share and test-cpu-budget: the settings keep the `TEST_SHARE_` prefix and the registry stays in `~/.cache/test-share`.

One file, `preload.cjs`, is loaded into every node process through `NODE_OPTIONS`. It does two things:

- **Budget.** All `vitest` runs together may use `floor(cores * 0.8)` workers: 12 of this Mac's 15 cores, so the CPU is used but not filled. Each run registers itself in `~/.cache/test-share/runs/<pid>` with the workers it took. A new run gets `min(floor(BUDGET / active runs), workers still free)`. Alone: 12. Two started together: 6 each. Four started together: 3 each.
- **Wait.** A run that arrives when fewer than `TEST_SHARE_MIN` workers are free waits, before vitest starts, until a share is free. It says so on stderr when it starts waiting and again when it starts running. See "Waiting" below.
- **Priority.** `vitest` and `tsc` (also `vue-tsc`) are set to nice 10, and their workers inherit it, so interactive apps go first.

Every other node process (npm, vite, vitest's own workers, scripts) leaves after one string check: about 0.3 ms.

## Switch on

Add to the `env` block of `~/.claude/settings.json`:

```json
"NODE_OPTIONS": "--require /Users/casandra/Code/Personal/agent-cpu-budget-protocol/preload.cjs"
```

For one shell: `export NODE_OPTIONS="--require /Users/casandra/Code/Personal/agent-cpu-budget-protocol/preload.cjs"`.

## Switch off

- One command or shell: `TEST_SHARE=0`.
- Everywhere: remove the `NODE_OPTIONS` line.

## Knobs

| Variable | Default | Effect |
| --- | --- | --- |
| `TEST_SHARE=0` | on | Disables everything. |
| `TEST_SHARE_BUDGET` | `floor(cores * 0.8)` = 12 | Total vitest workers across all runs, as a number. |
| `TEST_SHARE_MIN` | `2` | Smallest share a run is given. A run waits until this many workers are free. |
| `TEST_SHARE_WAIT` | `60` | Longest wait for a free share, in seconds. `0` never waits. |
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

## Waiting

- **When.** A run waits when fewer than `TEST_SHARE_MIN` workers are free, or when an earlier run is already waiting.
- **Wake rule.** It checks the registry twice a second and starts as soon as `TEST_SHARE_MIN` workers are free and no earlier run is waiting. It then takes what is free, up to `floor(BUDGET / active runs)`, where the runs still waiting behind it count as active. One run holding 12 with three waiting: when it ends, the three take 4 each.
- **Order.** First come, first served by start time. A later run never starts ahead of an earlier waiter, even when its own number would fit.
- **Bound.** After `TEST_SHARE_WAIT` seconds (default 60) it stops waiting and starts with `TEST_SHARE_MIN` workers, so the total can then pass the budget by that much for each run that timed out. The bound is there because agents run tests inside tool calls with their own timeouts.
- **Explicit numbers.** A run whose worker count the caller fixed (`VITEST_MAX_*` or `--maxWorkers`) waits the same way until that many workers are free (at most the whole budget), then starts with its own number. After the timeout it starts with its own number anyway.
- **Not silent.** Two stderr lines, printed without `TEST_SHARE_DEBUG`:
  `agent-cpu-budget-protocol: 12 of 12 test workers in use by 1 other run; waiting up to 60s for a free share (TEST_SHARE_WAIT=0 to skip)`
  `agent-cpu-budget-protocol: waited 9s; starting with 4 test workers`
- **Killed runs.** A holder or waiter that dies frees its place at the next check (within half a second). Ctrl-C or SIGTERM during the wait ends the run at once.
- **Started together.** Every run pauses 100 ms after joining the registry before it decides, so runs started in the same instant see each other and split the budget evenly instead of the last one waiting.

## Watch mode

A watch run (`vitest`, `vitest watch`, `--watch` on a terminal) is registered and niced, but claims nothing from the budget, is not capped and is not counted by other runs. It lives for hours and sits idle most of that time, so holding part of the budget for it would starve every other run while it does nothing. It keeps vitest's own watch default, half the cores (7), so while a watch run is re-running tests next to a full budget the total can pass the budget by up to 7.

## Known limits

- **A run keeps the worker count it started with.** A run that started with a small share does not grow when others finish.
- **The budget can be passed after a wait times out** (by `TEST_SHARE_MIN` per timed-out run, or by a caller's explicit number), and by a watch run that is re-running tests.
- **A waiter with a large explicit number holds up the runs behind it** until that number is free or it times out.
- **A run killed while waiting leaves its registry entry behind**, as `kill -9` does. It is ignored at once and deleted by the next run or waiter.
- **This is not a lock.** Runs agree on an order through the registry; under heavy load two of them can still read it at the wrong moment and take more than their part.
- **The config limit is read as text.** The `VITEST_MAX_*` variables win over the config file in vitest, so a limit the preload cannot read (computed, imported, or in a config outside the working folder and not named with `--config`) is replaced by the share.
- **Only `vitest` started from its CLI is shared.** Vitest started from a script through its node API, jest, playwright and other runners are not seen.
- **A script that sets its own `NODE_OPTIONS`** replaces this one, so the preload is absent for it. Nothing breaks; that command is just not shared or niced. To keep both: `NODE_OPTIONS="--max-old-space-size=4096 $NODE_OPTIONS"`.
- **Nice lowers priority; it does not move work to efficiency cores** or limit memory.
- **`kill -9` leaves a registry entry behind.** It is ignored at once (the pid is dead) and deleted by the next run. An entry whose pid is alive but which has not been touched for 5 minutes is dropped too (live runs touch theirs every 30 seconds).
- A priority already lower than `TEST_SHARE_NICE` is left alone.
