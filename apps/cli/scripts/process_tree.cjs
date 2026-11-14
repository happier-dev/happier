const nodePath = require('node:path');
const nodeFs = require('node:fs');
const nodeChildProcess = require('node:child_process');

// ps-list runs fastlist.exe on Windows from a path relative to its own module file. Inside the
// Bun-compiled CLI that module lives in Bun's virtual filesystem (B:/~BUN/root/...), which Windows
// cannot execute, so every enumeration fails. The CLI payload also ships a real copy of ps-list
// under node_modules next to the executable; when ps-list fails on Windows, run that copy directly.
const FASTLIST_BINARY_BY_ARCH = { x64: 'fastlist-0.3.0-x64.exe', ia32: 'fastlist-0.3.0-x86.exe' };
const FASTLIST_MAX_BUFFER_BYTES = 10 * 1000 * 1000;

function resolveWindowsFastlistPath({
  execPath = process.execPath,
  arch = process.arch,
  existsSync = nodeFs.existsSync,
  resolvePsListEntry = () => require.resolve('ps-list'),
} = {}) {
  const binary = FASTLIST_BINARY_BY_ARCH[arch];
  if (!binary) return null;
  const candidates = [nodePath.join(nodePath.dirname(execPath), 'node_modules', 'ps-list', 'vendor', binary)];
  try {
    candidates.push(nodePath.join(nodePath.dirname(resolvePsListEntry()), 'vendor', binary));
  } catch {
    // ps-list is not resolvable from here; the executable-relative candidate may still exist.
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// Same output contract as ps-list's Windows implementation: "pid\tppid\tname" per line.
function parseFastlistOutput(stdout) {
  return String(stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .map(([pid, ppid, name]) => ({ pid: Number.parseInt(pid, 10), ppid: Number.parseInt(ppid, 10), name }));
}

function listWindowsProcessesWithFastlist(binaryPath, execFile = nodeChildProcess.execFile) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, [], { maxBuffer: FASTLIST_MAX_BUFFER_BYTES, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(parseFastlistOutput(stdout));
    });
  });
}

function withWindowsFastlistFallback(enumerate, {
  platform = process.platform,
  resolveFastlistPath = resolveWindowsFastlistPath,
  listWithFastlist = listWindowsProcessesWithFastlist,
} = {}) {
  return async () => {
    try {
      return await enumerate();
    } catch (error) {
      if (platform !== 'win32') throw error;
      const fastlistPath = resolveFastlistPath();
      if (!fastlistPath) throw error;
      return await listWithFastlist(fastlistPath);
    }
  };
}

const psList = withWindowsFastlistFallback(async () => (await import('ps-list')).default());

function isPidAliveBySignal(pid, onProbeFailure) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access denial or an unrecognized probe failure does not establish process death.
    const absent = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
    if (!absent) onProbeFailure?.();
    return !absent;
  }
}

async function resolveDescendantPidsOnce(rootPid, enumerate) {
  const processes = await enumerate();
  const childrenByParent = new Map();
  for (const p of processes) {
    if (typeof p.pid !== 'number' || typeof p.ppid !== 'number') continue;
    const list = childrenByParent.get(p.ppid) ?? [];
    list.push(p.pid);
    childrenByParent.set(p.ppid, list);
  }

  const out = [];
  const seen = new Set();
  const visit = (pid) => {
    const kids = childrenByParent.get(pid) ?? [];
    for (const childPid of kids) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      visit(childPid);
      out.push(childPid);
    }
  };

  visit(rootPid);
  return out;
}

async function resolveDescendantPids(rootPid, enumerate) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await resolveDescendantPidsOnce(rootPid, enumerate);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function bestEffortKillPid(pid, signal, onSignalFailure) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      onSignalFailure();
    }
  }
}

async function waitForAllGone(pids, timeoutMs, isAlive) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Roots currently held by the discovery fence below. A stopped process never acts on SIGTERM,
// so if this owner exits or is signalled mid-discovery the root would stay frozen and orphaned.
const fencedRoots = new Set();
let fenceExitGuardInstalled = false;
const FENCE_TERMINATION_SIGNALS = process.platform === 'win32' ? [] : ['SIGTERM', 'SIGINT', 'SIGHUP'];

function releaseFencedRoots() {
  for (const proc of fencedRoots) {
    if (proc.exitCode != null || proc.signalCode != null) continue;
    bestEffortKillPid(proc.pid, 'SIGTERM', () => {});
    bestEffortKillPid(proc.pid, 'SIGCONT', () => {});
  }
  fencedRoots.clear();
  removeFenceSignalGuards();
}

function onFenceSignal(signal) {
  // Listening for a signal replaces its default termination; restore it when no other owner handles it.
  // The guard is prepended, so every other handler (including one-time handlers) is still registered here.
  const otherOwnersHandleSignal = process.listenerCount(signal) > 1;
  // An existing shutdown handler may still await discovery. Keep its ancestry fence
  // until cleanup resumes normally or the exit guard observes the owner's actual exit.
  if (otherOwnersHandleSignal) return;
  releaseFencedRoots();
  process.kill(process.pid, signal);
}

function removeFenceSignalGuards() {
  for (const signal of FENCE_TERMINATION_SIGNALS) process.off(signal, onFenceSignal);
}

function holdFencedRoot(proc) {
  if (!fenceExitGuardInstalled) {
    fenceExitGuardInstalled = true;
    process.on('exit', releaseFencedRoots);
  }
  if (fencedRoots.size === 0) {
    for (const signal of FENCE_TERMINATION_SIGNALS) process.prependListener(signal, onFenceSignal);
  }
  fencedRoots.add(proc);
}

function releaseFencedRoot(proc) {
  fencedRoots.delete(proc);
  if (fencedRoots.size === 0) removeFenceSignalGuards();
}

async function killProcessTree(proc, opts, enumerate = psList) {
  const pid = proc.pid;
  const rootHasExited = () => proc.exitCode != null || proc.signalCode != null;
  if (!pid || rootHasExited()) return { rootObservedAlive: false };

  const graceMs = Math.max(1, opts?.graceMs ?? 1000);
  let probeFailed = false;
  let signallingFailed = false;
  const onSignalFailure = () => { signallingFailed = true; };
  // An observed child exit revokes authority over its numeric PID, including after a wait.
  const isAlive = (targetPid) => !(targetPid === pid && rootHasExited())
    && isPidAliveBySignal(targetPid, () => { probeFailed = true; });
  const kill = (targetPid, signal) => {
    if (targetPid !== pid || !rootHasExited()) bestEffortKillPid(targetPid, signal, onSignalFailure);
  };

  // Keep child runtimes attached to their owning CLI process tree and explicitly terminate
  // descendants on disposal so provider processes cannot outlive their supervisor.
  // On POSIX, stop the root before taking the process-tree snapshot. Without this fence, a
  // freshly spawned descendant can be reported to its parent before it is visible in the
  // process listing; killing the parent then reparents that descendant and loses the only
  // relationship that lets this owner find it.
  let rootObservedAlive = isAlive(pid);
  const rootStopped = process.platform !== 'win32' && rootObservedAlive;
  if (rootStopped) {
    holdFencedRoot(proc);
    kill(pid, 'SIGSTOP');
  }

  let descendants;
  let discoveryFailed = false;
  try {
    descendants = await resolveDescendantPids(pid, enumerate);
  } catch {
    // Process enumeration is an external best-effort boundary. The known root must still be
    // resumed and terminated when the OS denies or transiently exhausts that boundary; making
    // every caller fail before that attempt leaves the known root alive. Afterward,
    // missing discovery remains an unverified cleanup, not successful completion.
    discoveryFailed = true;
    descendants = [];
  }
  // Discovery yields to the OS: an externally killed root may have lost its descendants.
  // Retain discovered descendants, but never resume or signal an exited root by its stale PID.
  if (rootHasExited()) rootObservedAlive = false;
  const all = rootHasExited() ? descendants : [...descendants, pid];

  // Try graceful first (children-first).
  for (const targetPid of descendants) kill(targetPid, 'SIGTERM');
  if (rootStopped) kill(pid, 'SIGCONT');
  kill(pid, 'SIGTERM');
  releaseFencedRoot(proc);
  await waitForAllGone(all, graceMs, isAlive);

  const remaining = all.filter((p) => isAlive(p));
  if (remaining.length === 0 && !discoveryFailed && !probeFailed && !signallingFailed) return { rootObservedAlive };

  for (const targetPid of remaining) kill(targetPid, 'SIGKILL');
  await waitForAllGone(remaining, Math.min(250, graceMs), isAlive);
  // A signalable PID alone may be a defunct child. Preserve the existing reap semantics;
  // only actual OS failures make this best-effort cleanup explicitly incomplete.
  if (discoveryFailed || probeFailed || signallingFailed) {
    throw Object.assign(new Error('Process-tree termination could not be verified'), {
      code: 'process_tree_termination_incomplete',
      // Keep only failure categories: native errors can contain private paths or command lines.
      discoveryFailed,
      probeFailed,
      signallingFailed,
    });
  }
  return { rootObservedAlive };
}

module.exports = {
  isPidAliveBySignal,
  killProcessTree,
  parseFastlistOutput,
  resolveWindowsFastlistPath,
  withWindowsFastlistFallback,
};
