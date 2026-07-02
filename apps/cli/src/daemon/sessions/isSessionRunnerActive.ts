import type { TrackedSession } from '../types';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from '../processRunState';
import { readSessionRunnerLockStatus, type SessionRunnerLockStatus } from '../sessionRunnerLock';

import { findHappyProcessByPid } from '../doctor';
import { hashProcessCommand } from '../sessionRegistry';

function normalizeSessionId(raw: unknown): string {
  return String(raw ?? '').trim();
}

async function getProcessCommandHashDefault(pid: number): Promise<string | null> {
  const proc = await findHappyProcessByPid(pid).catch(() => null);
  if (!proc?.command) return null;
  return hashProcessCommand(proc.command);
}

function trackedSessionMatchesSessionId(tracked: TrackedSession, sessionId: string): boolean {
  const trackedHappySessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
  const trackedExistingSessionId =
    tracked.spawnOptions && typeof tracked.spawnOptions.existingSessionId === 'string'
      ? tracked.spawnOptions.existingSessionId.trim()
      : '';
  return trackedHappySessionId === sessionId || trackedExistingSessionId === sessionId;
}

function isValidCommandHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

type ReadProcessRunState = (pid: number) => Promise<ProcessRunState>;

/**
 * "Active" means the runner can actually SERVE the session (consume pending messages, answer RPC).
 * A merely-signalable pid is not enough: a SIGSTOPped or zombie runner passes `kill(pid, 0)` but
 * serves nothing, and refusing a resume for it loses the user's message (incident 2026-06-12,
 * "Resume requested ... but session is already running"). Probe failures stay fail-closed:
 * an alive pid whose state cannot be inspected is treated as servable.
 */
async function isPidActivelyServing(pid: number, readProcessRunState: ReadProcessRunState): Promise<boolean> {
  const state = await readProcessRunState(pid).catch<ProcessRunState>(() => 'servable');
  return state === 'servable';
}

async function commandHashProvesPidReuse(params: {
  storedHash: string | null | undefined;
  pid: number;
  getProcessCommandHash: (pid: number) => Promise<string | null>;
}): Promise<boolean> {
  if (!isValidCommandHash(params.storedHash)) return false;

  const currentHash = await params.getProcessCommandHash(params.pid).catch(() => null);
  return isValidCommandHash(currentHash) && currentHash !== params.storedHash;
}

async function isLockActive(params: {
  sessionId: string;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash: (pid: number) => Promise<string | null>;
  readSessionRunnerLockStatus: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}): Promise<boolean> {
  const status = await params.readSessionRunnerLockStatus({ sessionId: params.sessionId }).catch(() => null);
  if (!status || !status.ok) return false;

  const pid = status.lock.pid;
  if (!(await isPidActivelyServing(pid, params.readProcessRunState))) return false;

  // If the lock PID is alive but its command hash is provably different, the OS reused
  // the PID for another process. Treat it as inactive so acquisition can break the stale lock.
  if (
    await commandHashProvesPidReuse({
      storedHash: status.lock.processCommandHash,
      pid,
      getProcessCommandHash: params.getProcessCommandHash,
    })
  ) {
    return false;
  }

  // Fail-closed: a lock with a live servable PID is treated as active unless we can prove PID reuse.
  return true;
}

async function isTrackedSessionActive(params: {
  sessionId: string;
  tracked: TrackedSession;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash: (pid: number) => Promise<string | null>;
}): Promise<boolean> {
  if (!trackedSessionMatchesSessionId(params.tracked, params.sessionId)) return false;

  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = childPid ?? params.tracked.pid;

  // A stopped/zombie runner cannot serve a resume even when the daemon holds a live
  // ChildProcess handle for it; reporting it inactive lets the resume respawn instead of
  // refusing and stranding the user's message in the pending queue.
  if (!(await isPidActivelyServing(pidToCheck, params.readProcessRunState))) return false;

  // If the daemon has a live ChildProcess handle, treat the runner as active even if process inspection is flaky.
  // This avoids spawning duplicates due to transient ps/command-line inspection failures.
  if (childPid) return true;

  // If this is only daemon bookkeeping, a matching live PID is not enough: the OS may have
  // reused the PID after the original runner exited. Only a valid hash mismatch proves that.
  if (
    await commandHashProvesPidReuse({
      storedHash: params.tracked.processCommandHash,
      pid: pidToCheck,
      getProcessCommandHash: params.getProcessCommandHash,
    })
  ) {
    return false;
  }

  return true;
}

export async function isSessionRunnerActive(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: (pid: number) => Promise<string | null>;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<boolean> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return false;

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const getProcessCommandHash = params.getProcessCommandHash ?? getProcessCommandHashDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of params.trackedSessions) {
    if (await isTrackedSessionActive({ sessionId, tracked, readProcessRunState, getProcessCommandHash })) return true;
  }

  return await isLockActive({ sessionId, readProcessRunState, getProcessCommandHash, readSessionRunnerLockStatus: readLockStatus });
}
