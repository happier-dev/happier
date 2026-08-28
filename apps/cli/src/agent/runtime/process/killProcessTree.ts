import {
  execFileWithDeadline,
  isPidPresent,
  probeProcessGroupLiveness,
} from '@happier-dev/cli-common/process';
import psList from 'ps-list';

import { taskkillWindowsProcessTree } from '@/subprocess/supervision/taskkillWindowsProcessTree';

const DESCENDANT_DISCOVERY_TIMEOUT_MS = 150;
const DESCENDANT_DISCOVERY_INTERVAL_MS = 25;
const DIRECT_CHILD_COMMAND_TIMEOUT_MS = 500;

type ProcessTreeRoot = Readonly<{
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}>;

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
  // Signal-only: nothing reads this command's output, and `pkill` exits 1 when nothing matched.
  await execFileWithDeadline('pkill', [`-${signalName}`, '-P', String(parentPid)], {
    timeout: DIRECT_CHILD_COMMAND_TIMEOUT_MS,
  }).catch(() => {});
}

async function bestEffortReadDirectChildPids(parentPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];

  // The deadline is owned here rather than by `child_process`, whose `timeout` destroys a
  // finished `pgrep`'s buffered pid list and still reports success. That empty list is read below
  // as "this process has no direct children", and the kill walks past them — leaving the user's
  // agent subprocesses running after their session was terminated.
  //
  // `pgrep` exits 1 when nothing matched, so both settlements are read the same way: the pid list
  // it printed, or nothing.
  const stdout = await execFileWithDeadline('pgrep', ['-P', String(parentPid)], {
    timeout: DIRECT_CHILD_COMMAND_TIMEOUT_MS,
  }).then(
    (result) => String(result.stdout ?? ''),
    (error: unknown) => String((error as { stdout?: unknown } | null)?.stdout ?? ''),
  );

  const childPids = stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== parentPid);
  return Array.from(new Set(childPids));
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
    if (pids.every((pid) => !isPidPresent(pid))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForProcessGroupGone(groupLeaderPid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (probeProcessGroupLiveness(groupLeaderPid) === 'absent') return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return probeProcessGroupLiveness(groupLeaderPid) === 'absent';
}

function terminationIncomplete(): Error {
  return Object.assign(
    new Error('Process-tree termination could not be verified'),
    { code: 'plugin_exec_termination_incomplete' },
  );
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

  if (
    (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined)
  ) {
    // The original root is known terminal. A live process at the same PID is
    // therefore a replacement, and its same-number process group must never
    // inherit cleanup custody from the retired root.
    if (isPidPresent(pid)) throw terminationIncomplete();
  }
  const shouldSignalProcessGroup = process.platform !== 'win32'
    && probeProcessGroupLiveness(pid) !== 'absent';

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
    const remaining = all.filter((targetPid) => isPidPresent(targetPid));
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

  const remaining = all.filter((p) => isPidPresent(p));
  if (remaining.length === 0 && !shouldSignalProcessGroup) return;

  if (shouldSignalProcessGroup) {
    bestEffortKillProcessGroup(pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, graceMs)));
    bestEffortKillProcessGroup(pid, 'SIGKILL');
    if (!await waitForProcessGroupGone(pid, Math.min(250, graceMs))) {
      throw terminationIncomplete();
    }
  }

  if (remaining.length === 0) return;

  for (const targetPid of remaining) await bestEffortSignalDirectChildren(targetPid, 'SIGKILL');
  for (const targetPid of remaining) bestEffortKillPid(targetPid, 'SIGKILL');
  await waitForAllGone(remaining, Math.min(250, graceMs));
  if (remaining.some((targetPid) => isPidPresent(targetPid))) {
    throw terminationIncomplete();
  }
}
