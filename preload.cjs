'use strict';
/*
 * test-share preload. Loaded into every node process with
 *   NODE_OPTIONS=--require /Users/casandra/Code/Personal/test-share/preload.cjs
 *
 * Non-targets leave through the few lines at the bottom of this file: no requires, no I/O.
 * Targets:
 *   - a vitest main process: registered in the registry, given workers out of a machine-wide budget, and niced
 *   - tsc / vue-tsc: niced
 * Nothing here may throw: every entry point is wrapped and fails open.
 */

var HEARTBEAT_MS = 30000; // a live run touches its registry entry this often
var STALE_MS = 5 * 60000; // an entry not touched for this long is dropped even if its pid is alive (pid reuse)
var BUDGET_FRACTION = 0.8; // default budget: this part of the cores, for all runs together

var BIN_RE = /[\\/]\.?bin[\\/](vitest|tsc|vue-tsc)(?:\.[cm]?js)?$/;
var VITEST_RE = /[\\/]vitest[\\/](?:vitest\.mjs|dist[\\/]cli\.js)$/;
var TSC_RE = /[\\/](?:typescript[\\/]lib[\\/]_?tsc\.js|vue-tsc[\\/](?:bin[\\/]vue-tsc\.js|index\.js))$/;
// the caller chose a worker count on the command line: hands off
var EXPLICIT_ARG_RE = /^--(?:(?:max|min)-?workers|pool-?options\.\w+\.(?:max|min|single)|no-file-parallelism|file-?parallelism)/i;
var ARG_MAX_RE = /^--(?:max-?workers|pool-?options\.\w+\.max\w+)(?:=(.*))?$/i;
var ARG_ONE_RE = /^--(?:no-file-parallelism|file-?parallelism=false|pool-?options\.\w+\.single\w+(?:=true)?)$/i;
// a literal worker limit in a config file: `maxWorkers: 4`, `maxForks: '50%'`, `maxWorkers: cond ? undefined : '50%'`
var CONFIG_MAX_RE = /\bmax(?:Workers|Threads|Forks)\s*:\s*(?:[^,\n?]*\?\s*(?:undefined|['"]?(\d+)\s*(%?)['"]?)\s*:\s*)?(?:undefined|['"]?(\d+)\s*(%?)['"]?)\s*(?=[,}\n]|$)/g;
var CONFIG_NAMES = ['vitest.config', 'vite.config'];
var CONFIG_EXTS = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'];

/** 'vitest', 'tsc' or null, from the script path node was started with. */
function classify(script) {
  var m = BIN_RE.exec(script);
  if (m) return m[1] === 'vitest' ? 'vitest' : 'tsc';
  if (VITEST_RE.test(script)) return 'vitest';
  if (TSC_RE.test(script)) return 'tsc';
  return null;
}

function intEnv(name, fallback, min, max) {
  var n = parseInt(process.env[name], 10);
  if (!(n >= min)) return fallback; // also catches NaN
  return n > max ? max : n;
}

function registryDir() {
  return process.env.TEST_SHARE_DIR || require('path').join(require('os').homedir(), '.cache', 'test-share', 'runs');
}

function coreCount() {
  var os = require('os');
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

/** Total vitest workers allowed across all active runs. */
function budgetFor(cores) {
  return intEnv('TEST_SHARE_BUDGET', Math.max(1, Math.floor(cores * BUDGET_FRACTION)), 1, 4096);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** Replaces a registry entry in one step, so a reader never sees half of it. */
function writeEntry(fs, dir, entry) {
  var tmp = dir + '/.' + entry.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, dir + '/' + entry.pid);
}

/**
 * The live entries in the registry. With prune, dead and stale entries are deleted on the way.
 * An entry is a file named after the pid holding a line of JSON.
 */
function readRuns(dir, prune) {
  var fs = require('fs');
  var runs = [];
  var names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return runs;
  }
  var now = Date.now();
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!/^\d+$/.test(name)) continue;
    var pid = +name;
    var file = dir + '/' + name;
    try {
      var live = isAlive(pid) && (pid === process.pid || now - fs.statSync(file).mtimeMs < STALE_MS);
      if (!live) {
        if (prune) fs.unlinkSync(file);
        continue;
      }
      var info = {};
      try {
        info = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {} // unreadable: count it as a run that has claimed nothing yet
      info.pid = pid;
      runs.push(info);
    } catch (e) {} // vanished between readdir and stat: its run has ended
  }
  return runs;
}

/** Runs that draw on the budget. Watch runs are left out: they sit idle most of the time. */
function sharing(runs, exceptPid) {
  var out = [];
  for (var i = 0; i < runs.length; i++) if (runs[i].pid !== exceptPid && !runs[i].watch) out.push(runs[i]);
  return out;
}

function isNum(v) {
  return typeof v === 'number' && v === v;
}

/**
 * The workers a run may take, given the other runs that draw on the budget.
 *   share = max(min, min(floor(budget / active runs), budget - workers already claimed))
 * `seq` is this run's place in the start order (Infinity for "a run started now").
 * Claimed are the shares other runs have recorded, plus, for runs that started before this one and have
 * not recorded theirs yet, the share this same rule will give them. Runs that started after this one and
 * are still deciding are not counted: they count this one. That keeps runs started in the same instant
 * from each taking the whole budget.
 */
function claimFor(others, seq, pid, budget, min) {
  var active = others.length + 1;
  var even = Math.floor(budget / active);
  var claimed = 0;
  var pending = [];
  for (var i = 0; i < others.length; i++) {
    var r = others[i];
    if (isNum(r.share)) claimed += r.share;
    else if (isNum(r.seq) && (r.seq < seq || (r.seq === seq && r.pid < pid))) pending.push(r);
  }
  pending.sort(function (a, b) { return a.seq - b.seq || a.pid - b.pid; });
  for (var j = 0; j < pending.length; j++) claimed += Math.max(min, Math.min(even, budget - claimed));
  return { active: active, claimed: claimed, share: Math.max(min, Math.min(even, budget - claimed)) };
}

/** What `vitest <args>` will do: { skip } for commands that run no tests, else { watch }. */
function vitestMode(args) {
  var cmd = null;
  var run = false;
  var watch = false;
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (a === '--run' || a === '--watch=false' || a === '--no-watch') run = true;
    else if (a === '--watch' || a === '-w' || a === '--watch=true') watch = true;
    else if (cmd === null && a[0] !== '-') cmd = a;
  }
  if (cmd === 'list' || cmd === 'init') return { skip: true, watch: false };
  if (cmd === 'run' || run) return { skip: false, watch: false };
  if (cmd === 'watch' || cmd === 'dev' || watch) return { skip: false, watch: true };
  // vitest's own default: watch when stdin is a terminal and this is not CI
  return { skip: false, watch: !process.env.CI && require('tty').isatty(0) };
}

/** '4' or '50%' as a worker count, else null. */
function workerCount(text, cores) {
  var m = /^\s*(\d+)\s*(%?)\s*$/.exec(text == null ? '' : String(text));
  if (!m) return null;
  var n = +m[1];
  if (m[2]) n = Math.min(cores, Math.round((n / 100) * cores));
  return Math.max(1, n);
}

/** The worker count the command line asks for, or null when it cannot be read from the arguments. */
function argWorkers(args, cores) {
  var found = null;
  for (var i = 0; i < args.length; i++) {
    if (ARG_ONE_RE.test(args[i])) return 1;
    var m = ARG_MAX_RE.exec(args[i]);
    if (m) {
      var n = workerCount(m[1] !== undefined ? m[1] : args[i + 1], cores);
      if (n !== null && (found === null || n > found)) found = n;
    }
  }
  return found;
}

/**
 * The literal worker limit written in the project's vitest config, or null.
 * The VITEST_MAX_* variables win over the config file, so without this a budget share above the
 * project's own limit would raise it. Read as text only: a limit that is computed is not seen.
 * Where the file holds several (a ternary, or one per project) the highest is taken, so a run is never
 * held below a limit the project did not mean for it.
 */
function configLimit(args, cores) {
  try {
    var fs = require('fs');
    var files = [];
    for (var i = 0; i < args.length; i++) {
      if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) files.push(args[i + 1]);
      else if (args[i].indexOf('--config=') === 0) files.push(args[i].slice(9));
    }
    if (!files.length) {
      for (var n = 0; n < CONFIG_NAMES.length && !files.length; n++) {
        for (var e = 0; e < CONFIG_EXTS.length; e++) {
          if (fs.existsSync(CONFIG_NAMES[n] + CONFIG_EXTS[e])) {
            files.push(CONFIG_NAMES[n] + CONFIG_EXTS[e]);
            break;
          }
        }
      }
    }
    var highest = null;
    for (var f = 0; f < files.length; f++) {
      var text = fs.readFileSync(files[f], 'utf8');
      var m;
      CONFIG_MAX_RE.lastIndex = 0;
      while ((m = CONFIG_MAX_RE.exec(text))) {
        for (var g = 1; g <= 3; g += 2) {
          var c = m[g] === undefined ? null : workerCount(m[g] + m[g + 1], cores);
          if (c !== null && (highest === null || c > highest)) highest = c;
        }
      }
    }
    return highest;
  } catch (e) {
    return null;
  }
}

function lowerPriority(nice) {
  if (nice <= 0) return null;
  try {
    var os = require('os');
    if (os.getPriority(0) < nice) os.setPriority(0, nice);
    return os.getPriority(0);
  } catch (e) {
    return null;
  }
}

function registerVitest(mode, debug) {
  var fs = require('fs');
  var dir = registryDir();
  var file = dir + '/' + process.pid;
  var cores = coreCount();
  var budget = budgetFor(cores);
  var min = intEnv('TEST_SHARE_MIN', 2, 1, budget);
  var args = process.argv.slice(2);
  var entry = { pid: process.pid, started: Date.now(), cwd: process.cwd(), watch: mode.watch, cores: cores, share: null };

  // Start order between runs: the entry goes in first, then it is stamped, then the others are read.
  // A run that missed this entry read the folder before the stamp was taken, so its own stamp is earlier
  // and this run counts it. The clock is the machine-wide monotonic one, in microseconds.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry));
  process.on('exit', function () {
    try {
      fs.unlinkSync(file);
    } catch (e) {}
  });
  setInterval(function () {
    try {
      var now = new Date();
      fs.utimesSync(file, now, now);
    } catch (e) {}
  }, HEARTBEAT_MS).unref();
  var hr = process.hrtime();
  entry.seq = hr[0] * 1e6 + Math.floor(hr[1] / 1e3);
  writeEntry(fs, dir, entry);

  var runs = readRuns(dir, true); // always, so every start prunes
  if (mode.watch) {
    // A watch run lives for hours and is idle for most of them: it keeps vitest's watch default (half
    // the cores), claims nothing from the budget and is not counted by other runs.
    if (debug) debug.push('budget=' + budget, 'share=default', '(watch: not capped, not counted)');
    return;
  }
  var claim = claimFor(sharing(runs, process.pid), entry.seq, process.pid, budget, min);
  var share = claim.share;
  var set = [];
  var why = '';
  var taken;
  if (args.some(function (a) { return EXPLICIT_ARG_RE.test(a); })) {
    var fromArgs = argWorkers(args, cores);
    taken = fromArgs === null ? share : fromArgs;
    why = 'worker count given on the command line, left alone';
  } else {
    var limit = configLimit(args, cores);
    if (limit !== null && limit < share) {
      share = limit;
      why = 'kept to the limit in the project config';
    }
    // vitest 3.x reads VITEST_MAX_THREADS / VITEST_MAX_FORKS, 4.x and later read VITEST_MAX_WORKERS.
    // A value the caller already set always wins, and is what this run claims from the budget.
    var env = process.env;
    var names = ['VITEST_MAX_THREADS', 'VITEST_MAX_FORKS', 'VITEST_MAX_WORKERS'];
    var callerMax = null;
    for (var k = 0; k < names.length; k++) {
      var v = env[names[k]] ? workerCount(env[names[k]], cores) : null;
      if (v !== null && (callerMax === null || v > callerMax)) callerMax = v;
    }
    taken = callerMax === null ? share : callerMax;
    var fill = Math.min(share, taken); // for the variables the caller left unset
    for (var i = 0; i < 2; i++) {
      var maxName = names[i];
      var minName = maxName.replace('MAX', 'MIN');
      if (env[maxName]) continue;
      if (env[minName]) {
        // 3.x throws when min is above max: never go below a min the caller set.
        var callerMin = parseInt(env[minName], 10);
        if (callerMin > fill) {
          env[maxName] = String(callerMin);
          if (callerMin > taken) taken = callerMin;
        } else env[maxName] = String(fill);
      } else {
        // 3.x also throws when a min in the project's config is above the max. Its default min is the
        // max, so setting both keeps the default behaviour and overrides such a config value.
        env[maxName] = env[minName] = String(fill);
      }
      set.push(maxName);
    }
    if (!env.VITEST_MAX_WORKERS) {
      env.VITEST_MAX_WORKERS = String(fill);
      set.push('VITEST_MAX_WORKERS');
    }
    if (callerMax !== null) why = 'caller set VITEST_MAX_*=' + callerMax + ', left alone';
  }
  entry.share = taken;
  try {
    writeEntry(fs, dir, entry);
  } catch (e) {}
  if (debug) {
    debug.push('budget=' + budget, 'active=' + claim.active, 'claimed=' + claim.claimed, 'share=' + taken);
    if (set.length) debug.push('set=' + set.join(','));
    if (why) debug.push('(' + why + ')');
  }
}

function main(kind) {
  // Worker threads run the preload too, with the main thread's argv: only the main thread is a target.
  if (!require('worker_threads').isMainThread) return;
  var debug = process.env.TEST_SHARE_DEBUG === '1' ? ['[test-share] pid=' + process.pid, kind] : null;
  try {
    if (kind === 'vitest') {
      var mode = vitestMode(process.argv.slice(2));
      if (debug) debug.push(mode.skip ? 'no-tests' : mode.watch ? 'watch' : 'run');
      if (!mode.skip) registerVitest(mode, debug);
    }
  } catch (e) {
    if (debug) debug.push('error=' + (e && e.message));
  }
  var nice = lowerPriority(intEnv('TEST_SHARE_NICE', 10, 0, 19));
  if (debug) {
    debug.push('nice=' + (nice === null ? 'unchanged' : nice));
    try {
      process.stderr.write(debug.join(' ') + '\n');
    } catch (e) {}
  }
}

// For the status script. Loading this file from a non-target process does nothing else.
module.exports = { configLimit: configLimit, argWorkers: argWorkers, classify: classify, readRuns: readRuns, sharing: sharing, claimFor: claimFor, budgetFor: budgetFor, registryDir: registryDir, coreCount: coreCount, intEnv: intEnv };

// ---- the path every node process takes ----
try {
  var script = process.argv[1];
  if (script !== undefined && process.env.TEST_SHARE !== '0' && (script.indexOf('vitest') !== -1 || script.indexOf('tsc') !== -1)) {
    var kind = classify(script);
    if (kind !== null) main(kind);
  }
} catch (e) {}
