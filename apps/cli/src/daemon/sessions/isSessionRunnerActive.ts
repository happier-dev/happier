import type { TrackedSession } from '../types';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from '../processRunState';
import { readSessionRunnerLockStatus, type SessionRunnerLockStatus } from '../sessionRunnerLock';
import {
  isValidProcessCommandHash,
  readSessionRunnerProcessIdentity,
  storedProcessIdentityProvesPidReuse,
  type SessionRunnerProcessCommandHashReader,
  type SessionRunnerProcessInstanceFingerprintReader,
} from '../sessionRunnerProcessIdentity';
import type { SessionRunnerServiceability } from './pendingQueueWake';

function normalizeSessionId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function trackedSessionMatchesSessionId(tracked: TrackedSession, sessionId: string): boolean {
  const trackedHappySessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
  const trackedExistingSessionId =
    tracked.spawnOptions && typeof tracked.spawnOptions.existingSessionId === 'string'
      ? tracked.spawnOptions.existingSessionId.trim()
      : '';
  return trackedHappySessionId === sessionId || trackedExistingSessionId === sessionId;
}

type ReadProcessRunState = (pid: number) => Promise<ProcessRunState>;

/**
 * This is process-presence evidence for duplicate-spawn fencing, not proof that the runner can
 * serve session control. Exact-session serviceability is established separately by
 * `probeSessionRunnerServiceability`.
 */
async function isPidPresentForDuplicateFence(pid: number, readProcessRunState: ReadProcessRunState): Promise<boolean> {
  const state = await readProcessRunState(pid).catch<ProcessRunState>(() => 'servable');
  return state === 'servable';
}

async function storedProcessIdentityProvesCurrentPidReuse(params: {
  storedProcessCommandHash: string | null | undefined;
  storedProcessInstanceFingerprint: string | null | undefined;
  pid: number;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<boolean> {
  if (
    !isValidProcessCommandHash(params.storedProcessCommandHash)
    && !params.storedProcessInstanceFingerprint
  ) return false;
  return storedProcessIdentityProvesPidReuse({
    storedProcessInstanceFingerprint: params.storedProcessInstanceFingerprint,
    currentIdentity: await readSessionRunnerProcessIdentity({
      pid: params.pid,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    }),
  });
}

async function isLockActive(params: {
  sessionId: string;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}): Promise<boolean> {
  const status = await params.readSessionRunnerLockStatus({ sessionId: params.sessionId }).catch(() => null);
  if (!status || !status.ok) return false;

  const pid = status.lock.pid;
  if (!(await isPidPresentForDuplicateFence(pid, params.readProcessRunState))) return false;

  // Only an exact process-instance mismatch proves that the OS reused this live PID.
  if (
    await storedProcessIdentityProvesCurrentPidReuse({
      storedProcessCommandHash: status.lock.processCommandHash,
      storedProcessInstanceFingerprint: status.lock.processInstanceFingerprint,
      pid,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
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
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<boolean> {
  if (!trackedSessionMatchesSessionId(params.tracked, params.sessionId)) return false;

  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = childPid ?? params.tracked.pid;

  // A stopped/zombie runner is absent for duplicate-spawn purposes even when the daemon still
  // holds a ChildProcess handle for it.
  if (!(await isPidPresentForDuplicateFence(pidToCheck, params.readProcessRunState))) return false;

  // A live PID is not enough when an exact process-instance fingerprint proves reuse.
  if (
    await storedProcessIdentityProvesCurrentPidReuse({
      storedProcessCommandHash: params.tracked.processCommandHash,
      storedProcessInstanceFingerprint: params.tracked.processInstanceFingerprint,
      pid: pidToCheck,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
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
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<boolean> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return false;

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of params.trackedSessions) {
    if (await isTrackedSessionActive({
      sessionId,
      tracked,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    })) {
      return true;
    }
  }

  return await isLockActive({
    sessionId,
    readProcessRunState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    readSessionRunnerLockStatus: readLockStatus,
  });
}

export type SessionRunnerServiceabilityProbe =
  | Readonly<{ state: 'runner_absent' }>
  | Readonly<{ state: 'runner_unknown'; reason: 'runner_presence_unproven' }>
  | Readonly<{ state: 'runner_present'; control: SessionRunnerServiceability }>;

export type SessionRunnerResumeDecision =
  | Readonly<{ action: 'spawn' }>
  | Readonly<{ action: 'adopt' }>
  | Readonly<{ action: 'wait_for_exit'; reason: 'runtime_terminating' }>
  | Readonly<{ action: 'fence'; reason: string }>;

export function resolveSessionRunnerResumeDecision(probe: SessionRunnerServiceabilityProbe): SessionRunnerResumeDecision {
  if (probe.state === 'runner_absent') return { action: 'spawn' };
  if (probe.state === 'runner_unknown') return { action: 'fence', reason: probe.reason };
  if (probe.control.state === 'servable') return { action: 'adopt' };
  if (probe.control.state === 'recoverable_unservable' && probe.control.reason === 'runtime_terminating') {
    return { action: 'wait_for_exit', reason: 'runtime_terminating' };
  }
  return { action: 'fence', reason: probe.control.reason };
}

export async function probeSessionRunnerServiceability(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  probeCapability: () => Promise<SessionRunnerServiceability>;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
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
