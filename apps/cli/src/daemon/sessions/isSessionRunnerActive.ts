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

export async function classifyTrackedSessionRunnerPresence(params: {
  tracked: TrackedSession;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<SessionRunnerProcessPresence> {
  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = childPid ?? params.tracked.pid;
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const runState = await readProcessRunState(pidToCheck).catch(() => null);
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
    if (!trackedSessionMatchesSessionId(tracked, sessionId)) continue;
    if (await classifyTrackedSessionRunnerPresence({
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
  | Readonly<{
      action: 'wait_for_exit';
      reason: 'runtime_terminating' | 'rpc_method_unavailable' | 'rpc_failed';
    }>
  | Readonly<{ action: 'fence'; reason: string }>;

export function resolveSessionRunnerResumeDecision(probe: SessionRunnerServiceabilityProbe): SessionRunnerResumeDecision {
  if (probe.state === 'runner_absent') return { action: 'spawn' };
  if (probe.state === 'runner_unknown') return { action: 'fence', reason: probe.reason };
  if (probe.control.state === 'servable') return { action: 'adopt' };
  if (
    probe.control.reason === 'runtime_terminating'
    || probe.control.reason === 'rpc_method_unavailable'
    || probe.control.reason === 'rpc_failed'
  ) {
    return { action: 'wait_for_exit', reason: probe.control.reason };
  }
  return { action: 'fence', reason: probe.control.reason };
}

type SessionRunnerPresenceProbeParams = Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  readProcessRunState?: ReadProcessRunState;
  getProcessCommandHash?: SessionRunnerProcessCommandHashReader;
  getProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>;

export type SessionRunnerPresenceProbe =
  | Readonly<{ state: 'runner_present' }>
  | Exclude<SessionRunnerServiceabilityProbe, Readonly<{ state: 'runner_present' }>>;

/** Presence admission without performing or inventing a capability RPC result. */
export async function probeSessionRunnerPresence(
  params: SessionRunnerPresenceProbeParams,
): Promise<SessionRunnerPresenceProbe> {
  const sessionId = normalizeSessionId(params.sessionId);
  const trackedSessions = Array.from(params.trackedSessions);
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of trackedSessions) {
    if (!trackedSessionMatchesSessionId(tracked, sessionId)) continue;
    const presence = await classifyTrackedSessionRunnerPresence({
      tracked,
      readProcessRunState,
      getProcessCommandHash: params.getProcessCommandHash,
      getProcessInstanceFingerprint: params.getProcessInstanceFingerprint,
    });
    if (presence === 'present') {
      return { state: 'runner_present' };
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
    return { state: 'runner_present' };
  }
  if (lockPresence === 'absent' || lockPresence === 'recoverable_stopped') {
    return { state: 'runner_absent' };
  }
  return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
}

export async function probeSessionRunnerServiceability(params: SessionRunnerPresenceProbeParams & Readonly<{
  probeCapability: () => Promise<SessionRunnerServiceability>;
}>): Promise<SessionRunnerServiceabilityProbe> {
  const presence = await probeSessionRunnerPresence(params);
  return presence.state === 'runner_present'
    ? { ...presence, control: await params.probeCapability() }
    : presence;
}
