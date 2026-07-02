import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';

import psList from 'ps-list';

const DESCENDANT_DISCOVERY_TIMEOUT_MS = 150;
const DESCENDANT_DISCOVERY_INTERVAL_MS = 25;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readDescendantPids(rootPid: number): Promise<number[]> {
  const processes = await psList();
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
    const current = await readDescendantPids(rootPid);
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
    execFile('pkill', [`-${signalName}`, '-P', String(parentPid)], { timeout: 500 }, () => resolve());
  });
}

async function waitForAllGone(pids: number[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function killProcessTree(
  proc: ChildProcess,
  opts?: {
    graceMs?: number;
  }
): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;

  const graceMs = Math.max(1, opts?.graceMs ?? 1000);

  // Outer test harnesses often terminate the CLI process tree by pid. If we spawn ACP CLIs with
  // `detached: true`, the agent process falls outside that tree and can leak. Keep agents attached,
  // and explicitly kill descendants on dispose.
  const descendants = await resolveDescendantPids(pid).catch(() => []);
  const all = [...descendants, pid];

  for (const targetPid of all) await bestEffortSignalDirectChildren(targetPid, 'SIGTERM');
  for (const targetPid of all) bestEffortKillPid(targetPid, 'SIGTERM');
  await waitForAllGone(all, graceMs);

  const remaining = all.filter((p) => isAlive(p));
  if (remaining.length === 0) return;

  for (const targetPid of remaining) await bestEffortSignalDirectChildren(targetPid, 'SIGKILL');
  for (const targetPid of remaining) bestEffortKillPid(targetPid, 'SIGKILL');
  await waitForAllGone(remaining, Math.min(250, graceMs));
}
