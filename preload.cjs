'use strict';
/*
 * test-share preload. Loaded into every node process with
 *   NODE_OPTIONS=--require /Users/casandra/Code/Personal/test-share/preload.cjs
 *
 * Non-targets leave through the few lines at the bottom of this file: no requires, no I/O.
 * Targets:
 *   - a vitest main process: registered in the registry, given a share of the cores, and niced
 *   - tsc / vue-tsc: niced
 * Nothing here may throw: every entry point is wrapped and fails open.
 */

var HEARTBEAT_MS = 30000; // a live run touches its registry entry this often
var STALE_MS = 5 * 60000; // an entry not touched for this long is dropped even if its pid is alive (pid reuse)

var BIN_RE = /[\\/]\.?bin[\\/](vitest|tsc|vue-tsc)(?:\.[cm]?js)?$/;
var VITEST_RE = /[\\/]vitest[\\/](?:vitest\.mjs|dist[\\/]cli\.js)$/;
var TSC_RE = /[\\/](?:typescript[\\/]lib[\\/]_?tsc\.js|vue-tsc[\\/](?:bin[\\/]vue-tsc\.js|index\.js))$/;
// the caller chose a worker count on the command line: hands off
var EXPLICIT_ARG_RE = /^--(?:(?:max|min)-?workers|pool-?options\.\w+\.(?:max|min|single)|no-file-parallelism|file-?parallelism)/i;

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

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
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
      } catch (e) {} // unreadable: count it as a plain run
      info.pid = pid;
      runs.push(info);
    } catch (e) {} // vanished between readdir and stat: its run has ended
  }
  return runs;
}

/**
 * The worker count for a run that is one of `active` runs (itself included).
 * null means "leave vitest's own default" (cores - 1): the share would not lower it.
 */
function shareFor(active, cores, min) {
  var share = Math.max(min, Math.floor(cores / Math.max(active, 1)));
  return share >= Math.max(cores - 1, 1) ? null : share;
}

/** Runs that take a share. Watch runs are left out: they sit idle most of the time. */
function countActive(runs, exceptPid) {
  var n = 0;
  for (var i = 0; i < runs.length; i++) if (runs[i].pid !== exceptPid && !runs[i].watch) n++;
  return n;
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
  var min = intEnv('TEST_SHARE_MIN', 2, 1, cores);
  var entry = { pid: process.pid, started: Date.now(), cwd: process.cwd(), watch: mode.watch, cores: cores, share: null };

  // Register before counting, so two runs that start in the same instant each see the other.
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

  var runs = readRuns(dir, true); // always, so every start prunes
  // A watch run lives for hours, so a share taken from the runs active at its start would be wrong for
  // most of its life: it keeps vitest's watch default (half the cores) and is not counted by others.
  var active = mode.watch ? 1 : countActive(runs, process.pid) + 1;
  var share = mode.watch ? null : shareFor(active, cores, min);
  var set = [];
  var why = '';
  if (mode.watch) why = 'watch: not capped, not counted';
  else if (share === null) why = 'vitest default kept';
  else if (process.argv.slice(2).some(function (a) { return EXPLICIT_ARG_RE.test(a); })) {
    why = 'worker count given on the command line, left alone';
    share = null;
  } else {
    // vitest 3.x reads VITEST_MAX_THREADS / VITEST_MAX_FORKS, 4.x and later read VITEST_MAX_WORKERS.
    // A value the caller already set always wins.
    var env = process.env;
    var pools = ['THREADS', 'FORKS'];
    for (var i = 0; i < pools.length; i++) {
      var maxName = 'VITEST_MAX_' + pools[i];
      var minName = 'VITEST_MIN_' + pools[i];
      if (env[maxName]) continue;
      if (env[minName]) {
        // 3.x throws when min is above max: never go below a min the caller set.
        var callerMin = parseInt(env[minName], 10);
        env[maxName] = String(callerMin > share ? callerMin : share);
      } else {
        // 3.x also throws when a min in the project's config is above the max. Its default min is the
        // max, so setting both keeps the default behaviour and overrides such a config value.
        env[maxName] = env[minName] = String(share);
      }
      set.push(maxName);
    }
    if (!env.VITEST_MAX_WORKERS) {
      env.VITEST_MAX_WORKERS = String(share);
      set.push('VITEST_MAX_WORKERS');
    }
    if (!set.length) why = 'all VITEST_MAX_* already set by the caller';
    entry.share = share;
    try {
      fs.writeFileSync(file, JSON.stringify(entry));
    } catch (e) {}
  }
  if (debug) {
    debug.push('active=' + (mode.watch ? '-' : active), 'cores=' + cores, 'share=' + (share === null ? 'default' : share));
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
module.exports = { classify: classify, readRuns: readRuns, shareFor: shareFor, countActive: countActive, registryDir: registryDir, coreCount: coreCount, intEnv: intEnv };

// ---- the path every node process takes ----
try {
  var script = process.argv[1];
  if (script !== undefined && process.env.TEST_SHARE !== '0' && (script.indexOf('vitest') !== -1 || script.indexOf('tsc') !== -1)) {
    var kind = classify(script);
    if (kind !== null) main(kind);
  }
} catch (e) {}
