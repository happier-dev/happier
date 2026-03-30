import { spawnSync } from 'node:child_process';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function tryKillPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function tryKillGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function taskkillTree(pid: number): boolean {
  const command = process.env.COMSPEC || 'cmd.exe';
  const result = spawnSync(command, ['/d', '/s', '/c', `taskkill /PID ${pid} /T /F`], {
    stdio: 'ignore',
  });
  return (result.status ?? 1) === 0;
}

type ProcessEntry = {
  pid: number;
  ppid: number;
  pgid: number;
};

function listUnixProcesses(): ProcessEntry[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) {
    return [];
  }

  const entries: ProcessEntry[] = [];
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

export function collectDescendantPids(rootPid: number): number[] {
  if (process.platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) return [];

  const childrenByParent = new Map<number, number[]>();
  for (const entry of listUnixProcesses()) {
    if (entry.ppid <= 0) continue;
    const children = childrenByParent.get(entry.ppid);
    if (children) {
      children.push(entry.pid);
    } else {
      childrenByParent.set(entry.ppid, [entry.pid]);
    }
  }

  const descendants = new Set<number>();
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (typeof pid !== 'number' || pid <= 0 || descendants.has(pid)) continue;
    descendants.add(pid);
    const children = childrenByParent.get(pid);
    if (children) queue.push(...children);
  }

  return [...descendants];
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(groupId) || groupId <= 0) return true;
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function collectTreeTargets(rootPid: number, additionalPids: number[]): { pids: number[]; groupIds: number[] } {
  const snapshot = listUnixProcesses();
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry] as const));
  const childrenByParent = new Map<number, number[]>();

  for (const entry of snapshot) {
    if (entry.ppid <= 0) continue;
    const children = childrenByParent.get(entry.ppid);
    if (children) {
      children.push(entry.pid);
    } else {
      childrenByParent.set(entry.ppid, [entry.pid]);
    }
  }

  const roots = new Set<number>();
  if (Number.isInteger(rootPid) && rootPid > 0) roots.add(rootPid);
  for (const pid of additionalPids) {
    if (Number.isInteger(pid) && pid > 0) roots.add(pid);
  }

  const pids = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (typeof pid !== 'number' || pid <= 0 || pids.has(pid)) continue;
    pids.add(pid);
    const children = childrenByParent.get(pid);
    if (children) queue.push(...children);
  }

  const groupIds = new Set<number>();
  for (const rootPid of roots) {
    if (!Number.isInteger(rootPid) || rootPid <= 0) continue;
    const entry = byPid.get(rootPid);
    if (entry?.pgid && entry.pgid > 0 && entry.pgid === rootPid) {
      groupIds.add(entry.pgid);
      continue;
    }
    // Detached wrappers use the child pid as the process-group id on Unix. Preserve
    // that fallback even after the root process exits so orphaned descendants can be reaped.
    groupIds.add(rootPid);
  }
  for (const pid of pids) {
    const entry = byPid.get(pid);
    if (entry && entry.pgid > 0 && entry.pgid === pid) {
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

function signalTargets(targets: { pids: number[]; groupIds: number[] }, signal: NodeJS.Signals): void {
  for (const groupId of targets.groupIds) {
    signalProcessGroup(groupId, signal);
  }

  const orderedPids = [...targets.pids].sort((left, right) => right - left);
  for (const pid of orderedPids) {
    tryKillPid(pid, signal);
  }
}

function allTargetsStopped(targets: { pids: number[]; groupIds: number[] }): boolean {
  return targets.pids.every((pid) => !isProcessAlive(pid));
}

export async function terminateProcessTreeByPid(
  pid: number,
  options: { graceMs?: number; pollMs?: number; skipAliveCheck?: boolean; additionalPids?: number[] } = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;

  const graceMsRaw = options.graceMs;
  const pollMsRaw = options.pollMs;
  const skipAliveCheck = options.skipAliveCheck === true;
  const additionalPids = Array.isArray(options.additionalPids) ? options.additionalPids : [];
  const graceMs = typeof graceMsRaw === 'number' && Number.isInteger(graceMsRaw) && graceMsRaw >= 0 ? graceMsRaw : 10_000;
  const pollMs = typeof pollMsRaw === 'number' && Number.isInteger(pollMsRaw) && pollMsRaw > 0 ? pollMsRaw : 100;

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
