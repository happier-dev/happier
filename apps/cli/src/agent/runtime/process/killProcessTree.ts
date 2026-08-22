import { execFile } from 'node:child_process';

import psList from 'ps-list';

import { taskkillWindowsProcessTree } from '@/subprocess/supervision/taskkillWindowsProcessTree';

const DESCENDANT_DISCOVERY_TIMEOUT_MS = 150;
const DESCENDANT_DISCOVERY_INTERVAL_MS = 25;
const DIRECT_CHILD_COMMAND_TIMEOUT_MS = 500;

type ProcessTreeRoot = Readonly<{ pid?: number }>;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readDescendantPids(rootPid: number, timeoutMs: number): Promise<number[] | null> {
  const timedOut = Symbol('descendant-discovery-timeout');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const processes = await Promise.race([
    psList(),
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), Math.max(1, timeoutMs));
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (processes === timedOut) return null;

  const childrenByParent = new Map<number, number[]>();
  for (const p of processes) {
    if (typeof p.pid !== 'number' || typeof p.ppid !== 'number') continue;
    const list = childrenByParent.get(p.ppid) ?? [];
    list.push(p.pid);
    childrenByParent.set(p.ppid, list);
  }

  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (pid: number) => {
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

async function resolveDescendantPids(rootPid: number): Promise<number[]> {
  const descendants = new Set<number>();
  const startedAt = Date.now();

  while (Date.now() - startedAt < DESCENDANT_DISCOVERY_TIMEOUT_MS) {
    const remainingMs = DESCENDANT_DISCOVERY_TIMEOUT_MS - (Date.now() - startedAt);
    const current = await readDescendantPids(rootPid, remainingMs);
    if (current === null) break;
    for (const pid of current) descendants.add(pid);
    if (descendants.size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, DESCENDANT_DISCOVERY_INTERVAL_MS));
  }

  return Array.from(descendants);
}

function bestEffortKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

async function bestEffortSignalDirectChildren(parentPid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === 'win32') return;
  const signalName = signal.replace(/^SIG/, '');
  await new Promise<void>((resolve) => {
    execFile(
      'pkill',
      [`-${signalName}`, '-P', String(parentPid)],
      { timeout: DIRECT_CHILD_COMMAND_TIMEOUT_MS },
      () => resolve(),
    );
  });
}

async function bestEffortReadDirectChildPids(parentPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];

  return await new Promise<number[]>((resolve) => {
    execFile(
      'pgrep',
      ['-P', String(parentPid)],
      { encoding: 'utf8', timeout: DIRECT_CHILD_COMMAND_TIMEOUT_MS },
      (_error, stdout) => {
        const childPids = String(stdout ?? '')
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10))
          .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== parentPid);
        resolve(Array.from(new Set(childPids)));
      },
    );
  });
}

function hasProcessGroupForPid(pid: number): boolean {
  if (process.platform === 'win32') return false;

  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function bestEffortKillProcessGroup(groupLeaderPid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return;

  try {
    process.kill(-groupLeaderPid, signal);
  } catch {
    // ignore
  }
}

async function waitForAllGone(pids: number[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function killProcessTree(
  proc: ProcessTreeRoot,
  opts?: {
    graceMs?: number;
    terminateWindowsTree?: typeof taskkillWindowsProcessTree;
  }
): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;

  const graceMs = Math.max(1, opts?.graceMs ?? 1000);
  const shouldSignalProcessGroup = hasProcessGroupForPid(pid);

  // A detached POSIX child is its own process-group leader. Signal that group first so
  // late-forked descendants in the same group cannot escape the initial psList snapshot.
  // Keep the platform subtree fallbacks for Windows and non-detached roots, where no
  // group with this PID exists.
  if (shouldSignalProcessGroup) bestEffortKillProcessGroup(pid, 'SIGTERM');
  const descendants = await resolveDescendantPids(pid).catch(() => []);
  let directChildren: number[] = [];
  if (process.platform !== 'win32') {
    // Retain direct-child identities before the root can exit and reparent them. Run the
    // capture alongside the existing initial pkill slot rather than adding another wait phase.
    [directChildren] = await Promise.all([
      bestEffortReadDirectChildPids(pid),
      bestEffortSignalDirectChildren(pid, 'SIGTERM'),
    ]);
  }
  const all = Array.from(new Set([...descendants, ...directChildren, pid]));

  if (process.platform === 'win32') {
    const terminateWindowsTree = opts?.terminateWindowsTree ?? taskkillWindowsProcessTree;
    try {
      await terminateWindowsTree({ pid, force: false });
    } catch {
      for (const targetPid of all) bestEffortKillPid(targetPid, 'SIGTERM');
    }
    await waitForAllGone(all, graceMs);
    const remaining = all.filter((targetPid) => isAlive(targetPid));
    if (remaining.length === 0) return;
    try {
      await terminateWindowsTree({ pid, force: true });
    } catch {
      for (const targetPid of remaining) bestEffortKillPid(targetPid, 'SIGKILL');
    }
    await waitForAllGone(remaining, Math.min(250, graceMs));
    return;
  }

  for (const targetPid of all) {
    if (targetPid !== pid) await bestEffortSignalDirectChildren(targetPid, 'SIGTERM');
  }
  for (const targetPid of all) bestEffortKillPid(targetPid, 'SIGTERM');
  await waitForAllGone(all, graceMs);

  const remaining = all.filter((p) => isAlive(p));
  if (remaining.length === 0 && !shouldSignalProcessGroup) return;

  if (shouldSignalProcessGroup) {
    bestEffortKillProcessGroup(pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, graceMs)));
    bestEffortKillProcessGroup(pid, 'SIGKILL');
  }

  if (remaining.length === 0) return;

  for (const targetPid of remaining) await bestEffortSignalDirectChildren(targetPid, 'SIGKILL');
  for (const targetPid of remaining) bestEffortKillPid(targetPid, 'SIGKILL');
  await waitForAllGone(remaining, Math.min(250, graceMs));
}
