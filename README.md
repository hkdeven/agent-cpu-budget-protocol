# test-share

Stops parallel `vitest` and `tsc` runs from oversubscribing this Mac, without a fixed worker cap and without touching any project.

One file, `preload.cjs`, is loaded into every node process through `NODE_OPTIONS`. It does two things:

- **Share.** Each `vitest` run registers itself in `~/.cache/test-share/runs/<pid>`. A run that starts alone keeps vitest's default (cores - 1 workers). A run that starts while others are active gets `max(MIN, floor(cores / active runs))` workers, itself included in the count. On 15 cores: 14, then 7, 5, 3.
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
| `TEST_SHARE_MIN` | `2` | Smallest share a run is given. |
| `TEST_SHARE_NICE` | `10` | Nice value for vitest and tsc. `0` leaves priority alone. |
| `TEST_SHARE_DEBUG=1` | silent | One stderr line per target saying what was decided. |
| `TEST_SHARE_DIR` | `~/.cache/test-share/runs` | Registry folder. |

A worker count the caller chose always wins: `VITEST_MAX_THREADS`, `VITEST_MAX_FORKS` or `VITEST_MAX_WORKERS` already in the environment are left as they are, and so is a run with `--maxWorkers`, `--poolOptions.*.max*`, or `--no-file-parallelism` on the command line.

## Status

```
./status
```

Lists the registered runs and the share a run started now would get.

## How the share reaches vitest

The preload sets `VITEST_MAX_THREADS`, `VITEST_MAX_FORKS` (read by vitest 3.x, together with the matching `VITEST_MIN_*`, because 3.x throws when a min is above the max) and `VITEST_MAX_WORKERS` (read by 4.x and later). Vitest reads them when it resolves its config, after the preload has run. Checked against 3.2.7 and 5.0.5.

## Watch mode

A watch run (`vitest`, `vitest watch`, `--watch` on a terminal) is registered and niced, but is not capped and is not counted by other runs. It lives for hours and sits idle most of that time, so a share fixed at its start would be wrong for most of its life, and counting it would halve every other run while it does nothing. It keeps vitest's own watch default, half the cores.

## Known limits

- **A run keeps the worker count it started with.** The first of several runs keeps the larger share until it finishes, so four runs started a second apart hold 14 + 7 + 5 + 3 = 29 workers, not 15. Runs started in the same instant may each count a different number of others.
- **The share overrides a worker limit in the project's config**, because vitest lets these environment variables win over the config file. A config that asks for fewer workers than the share gets the share. (A360's `maxWorkers: '50%'` is 8 on this Mac and the share is never above 7, so it is not raised.)
- **Only `vitest` started from its CLI is shared.** Vitest started from a script through its node API, jest, playwright and other runners are not seen.
- **A script that sets its own `NODE_OPTIONS`** replaces this one, so the preload is absent for it. Nothing breaks; that command is just not shared or niced. To keep both: `NODE_OPTIONS="--max-old-space-size=4096 $NODE_OPTIONS"`.
- **Nice lowers priority; it does not move work to efficiency cores** or limit memory.
- **`kill -9` leaves a registry entry behind.** It is ignored at once (the pid is dead) and deleted by the next run. An entry whose pid is alive but which has not been touched for 5 minutes is dropped too (live runs touch theirs every 30 seconds).
- A priority already lower than `TEST_SHARE_NICE` is left alone.
