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

/** Process-presence evidence for duplicate-spawn fencing, not exact-session RPC serviceability. */
async function isPidPresentForDuplicateFence(pid: number, readProcessRunState: ReadProcessRunState): Promise<boolean> {
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
  if (!(await isPidPresentForDuplicateFence(pid, params.readProcessRunState))) return false;

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

  // Fail-closed: a lock with a present PID is treated as active unless we can prove PID reuse.
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

  if (!(await isPidPresentForDuplicateFence(pidToCheck, params.readProcessRunState))) return false;

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

export type SessionRunnerServiceability =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable'; reason: string }>
  | Readonly<{ state: 'unknown'; reason: string }>;

export type SessionRunnerServiceabilityProbe =
  | Readonly<{ state: 'runner_absent' }>
  | Readonly<{ state: 'runner_unknown'; reason: 'runner_presence_unproven' }>
  | Readonly<{ state: 'runner_present'; control: SessionRunnerServiceability }>;

export function resolveSessionRunnerResumeDecision(probe: SessionRunnerServiceabilityProbe):
  | Readonly<{ action: 'spawn' }>
  | Readonly<{ action: 'adopt' }>
  | Readonly<{ action: 'fence'; reason: string }> {
  if (probe.state === 'runner_absent') return { action: 'spawn' };
  if (probe.state === 'runner_unknown') return { action: 'fence', reason: probe.reason };
  return probe.control.state === 'servable'
    ? { action: 'adopt' }
    : { action: 'fence', reason: probe.control.reason };
}

export async function probeSessionRunnerServiceability(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  probeCapability: () => Promise<SessionRunnerServiceability>;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: (pid: number) => Promise<string | null>;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<SessionRunnerServiceabilityProbe> {
  const sessionId = normalizeSessionId(params.sessionId);
  const trackedSessions = Array.from(params.trackedSessions);
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;
  let lockStatusPromise: Promise<SessionRunnerLockStatus> | null = null;
  const readLockStatusOnce = async (input: { sessionId: string }): Promise<SessionRunnerLockStatus> => {
    lockStatusPromise ??= readLockStatus(input).catch((error: unknown) => ({
      ok: false,
      reason: 'io_error',
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
    return await lockStatusPromise;
  };
  const runnerPresent = await isSessionRunnerActive({
    ...params,
    trackedSessions,
    readProcessRunState,
    readSessionRunnerLockStatus: readLockStatusOnce,
  });
  if (!runnerPresent) {
    for (const tracked of trackedSessions) {
      if (!trackedSessionMatchesSessionId(tracked, sessionId)) continue;
      const childPid = typeof tracked.childProcess?.pid === 'number' ? tracked.childProcess.pid : null;
      const runState = await readProcessRunState(childPid ?? tracked.pid).catch(() => null);
      if (runState !== 'dead' && runState !== 'zombie') {
        return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
      }
    }

    const lockStatus = await readLockStatusOnce({ sessionId });
    if (!lockStatus.ok) {
      return lockStatus.reason === 'not_found'
        ? { state: 'runner_absent' }
        : { state: 'runner_unknown', reason: 'runner_presence_unproven' };
    }
    const lockRunState = await readProcessRunState(lockStatus.lock.pid).catch(() => null);
    return lockRunState === 'dead' || lockRunState === 'zombie'
      ? { state: 'runner_absent' }
      : { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  }
  return { state: 'runner_present', control: await params.probeCapability() };
}
