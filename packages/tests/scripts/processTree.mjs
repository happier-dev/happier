import { spawnSync } from 'node:child_process';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function tryKillPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true;
    return false;
  }
}

function taskkillTree(pid) {
  const command = process.env.COMSPEC || 'cmd.exe';
  const result = spawnSync(command, ['/d', '/s', '/c', `taskkill /PID ${pid} /T /F`], {
    stdio: 'ignore',
  });
  return (result.status ?? 1) === 0;
}

function listUnixProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) {
    return [];
  }

  const entries = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [pidText, ppidText, pgidText] = trimmed.split(/\s+/, 3);
    const pid = Number.parseInt(pidText ?? '', 10);
    const ppid = Number.parseInt(ppidText ?? '', 10);
    const pgid = Number.parseInt(pgidText ?? '', 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || pid <= 0 || pgid <= 0) continue;
    entries.push({ pid, ppid, pgid });
  }

  return entries;
}

function signalProcessGroup(groupId, signal) {
  if (!Number.isInteger(groupId) || groupId <= 0) return true;
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true;
    return false;
  }
}

function collectTreeTargets(rootPid, additionalPids) {
  const snapshot = listUnixProcesses();
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
  const childrenByParent = new Map();

  for (const entry of snapshot) {
    if (entry.ppid <= 0) continue;
    const children = childrenByParent.get(entry.ppid);
    if (children) {
      children.push(entry.pid);
    } else {
      childrenByParent.set(entry.ppid, [entry.pid]);
    }
  }

  const roots = new Set();
  if (Number.isInteger(rootPid) && rootPid > 0) roots.add(rootPid);
  for (const pid of additionalPids) {
    if (Number.isInteger(pid) && pid > 0) roots.add(pid);
  }

  const pids = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (typeof pid !== 'number' || pid <= 0 || pids.has(pid)) continue;
    pids.add(pid);
    const children = childrenByParent.get(pid);
    if (children) queue.push(...children);
  }

  const groupIds = new Set();
  for (const rootPid of roots) {
    if (!Number.isInteger(rootPid) || rootPid <= 0) continue;
    const entry = byPid.get(rootPid);
    if (entry?.pgid && entry.pgid > 0) {
      groupIds.add(entry.pgid);
      continue;
    }
    // Detached wrappers use the child pid as the process-group id on Unix. Preserve
    // that fallback even after the root process exits so orphaned descendants can be reaped.
    groupIds.add(rootPid);
  }
  for (const pid of pids) {
    const entry = byPid.get(pid);
    if (entry && entry.pgid > 0) {
      groupIds.add(entry.pgid);
    }
  }

  for (const entry of snapshot) {
    if (groupIds.has(entry.pgid)) {
      pids.add(entry.pid);
    }
  }

  return { pids: [...pids], groupIds: [...groupIds] };
}

function signalTargets(targets, signal) {
  for (const groupId of targets.groupIds) {
    signalProcessGroup(groupId, signal);
  }

  const orderedPids = [...targets.pids].sort((left, right) => right - left);
  for (const pid of orderedPids) {
    tryKillPid(pid, signal);
  }
}

function allTargetsStopped(targets) {
  return targets.pids.every((pid) => !isProcessAlive(pid));
}

export async function terminateProcessTreeByPid(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  const graceMs = Number.isInteger(options.graceMs) && options.graceMs >= 0 ? options.graceMs : 10_000;
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs > 0 ? options.pollMs : 100;
  const skipAliveCheck = options.skipAliveCheck === true;
  const additionalPids = Array.isArray(options.additionalPids) ? options.additionalPids : [];

  if (!skipAliveCheck && !isProcessAlive(pid) && additionalPids.every((extraPid) => !isProcessAlive(extraPid))) return;

  if (process.platform === 'win32') {
    taskkillTree(pid);
    for (const extraPid of additionalPids) {
      taskkillTree(extraPid);
    }
    return;
  }

  signalTargets(collectTreeTargets(pid, additionalPids), 'SIGTERM');

  const startedAt = Date.now();
  while (Date.now() - startedAt < graceMs) {
    const targets = collectTreeTargets(pid, additionalPids);
    if (targets.pids.length === 0 || allTargetsStopped(targets)) return;
    await sleep(pollMs);
  }

  signalTargets(collectTreeTargets(pid, additionalPids), 'SIGKILL');

  const killDeadline = Date.now() + Math.max(250, pollMs * 4);
  while (Date.now() < killDeadline) {
    const targets = collectTreeTargets(pid, additionalPids);
    if (targets.pids.length === 0 || allTargetsStopped(targets)) return;
    await sleep(pollMs);
  }
}
