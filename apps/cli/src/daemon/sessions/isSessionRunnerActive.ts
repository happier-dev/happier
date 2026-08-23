import type { TrackedSession } from '../types';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from '../processRunState';
import { readSessionRunnerLockStatus, type SessionRunnerLockStatus } from '../sessionRunnerLock';
import {
  classifySessionRunnerProcessPresence,
  isValidProcessCommandHash,
  readSessionRunnerProcessIdentity,
  type SessionRunnerProcessCommandHashReader,
  type SessionRunnerProcessInstanceFingerprintReader,
  type SessionRunnerProcessPresence,
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

async function classifyStoredProcessPresence(params: {
  storedProcessCommandHash: string | null | undefined;
  storedProcessInstanceFingerprint: string | null | undefined;
  pid: number;
  runState: ProcessRunState | null;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<SessionRunnerProcessPresence> {
  const hasStoredIdentity = isValidProcessCommandHash(params.storedProcessCommandHash)
    || Boolean(params.storedProcessInstanceFingerprint);
  const currentIdentity = hasStoredIdentity && params.runState !== 'dead' && params.runState !== 'zombie'
    ? await readSessionRunnerProcessIdentity({
        pid: params.pid,
        getProcessCommandHash: params.getProcessCommandHash,
        getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
      })
    : undefined;
  return classifySessionRunnerProcessPresence({
    runState: params.runState,
    storedProcessCommandHash: params.storedProcessCommandHash,
    storedProcessInstanceFingerprint: params.storedProcessInstanceFingerprint,
    currentIdentity,
  });
}

async function classifyLockPresence(params: {
  sessionId: string;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}): Promise<SessionRunnerProcessPresence> {
  const status = await params.readSessionRunnerLockStatus({ sessionId: params.sessionId }).catch(() => null);
  if (!status) return 'unknown';
  if (!status.ok) return status.reason === 'not_found' ? 'absent' : 'unknown';

  const pid = status.lock.pid;
  const runState = await params.readProcessRunState(pid).catch(() => null);
  return await classifyStoredProcessPresence({
    storedProcessCommandHash: status.lock.processCommandHash,
    storedProcessInstanceFingerprint: status.lock.processInstanceFingerprint,
    pid,
    runState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
  });
}

async function classifyTrackedSessionPresence(params: {
  sessionId: string;
  tracked: TrackedSession;
  readProcessRunState: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<SessionRunnerProcessPresence> {
  if (!trackedSessionMatchesSessionId(params.tracked, params.sessionId)) return 'absent';

  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = childPid ?? params.tracked.pid;
  const runState = await params.readProcessRunState(pidToCheck).catch(() => null);
  return await classifyStoredProcessPresence({
    storedProcessCommandHash: params.tracked.processCommandHash,
    storedProcessInstanceFingerprint: params.tracked.processInstanceFingerprint,
    pid: pidToCheck,
    runState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
  });
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
    if (await classifyTrackedSessionPresence({
      sessionId,
      tracked,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    }) === 'present') {
      return true;
    }
  }

  return await classifyLockPresence({
    sessionId,
    readProcessRunState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    readSessionRunnerLockStatus: readLockStatus,
  }) === 'present';
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
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<SessionRunnerServiceabilityProbe> {
  const sessionId = normalizeSessionId(params.sessionId);
  const trackedSessions = Array.from(params.trackedSessions);
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of trackedSessions) {
    if (!trackedSessionMatchesSessionId(tracked, sessionId)) continue;
    const presence = await classifyTrackedSessionPresence({
      sessionId,
      tracked,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    });
    if (presence === 'present') {
      return { state: 'runner_present', control: await params.probeCapability() };
    }
    if (presence !== 'absent') {
      return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
    }
  }

  const lockPresence = await classifyLockPresence({
    sessionId,
    readProcessRunState,
    getProcessCommandHash: params.getProcessCommandHash,
    getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    readSessionRunnerLockStatus: readLockStatus,
  });
  if (lockPresence === 'present') {
    return { state: 'runner_present', control: await params.probeCapability() };
  }
  if (lockPresence === 'absent' || lockPresence === 'recoverable_stopped') {
    return { state: 'runner_absent' };
  }
  return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
}
