import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import type { TrackedSession } from '../types';
import { readProcessRunState as readProcessRunStateDefault, type ProcessRunState } from '../processRunState';
import {
  classifySessionRunnerProcessPresence,
  readSessionRunnerLockStatus,
  type SessionRunnerLockStatus,
  type SessionRunnerProcessInstanceFingerprintReader,
  type SessionRunnerProcessPresence,
} from '../sessionRunnerLock';

import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand } from '../sessionRegistry';

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
  runState: ProcessRunState | null;
  storedProcessStartTimeMs?: number;
  storedProcessInstanceFingerprint?: string;
  storedProcessCommandHash?: string;
  pid: number;
  readProcessIdentityByPid: typeof readProcessIdentityByPid;
  readProcessInstanceFingerprint: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<SessionRunnerProcessPresence> {
  const shouldReadIdentity = params.runState !== 'dead' && params.runState !== 'zombie'
    && (
      params.storedProcessStartTimeMs !== undefined
      || (params.runState === 'stopped' && Boolean(params.storedProcessCommandHash))
    );
  const currentIdentity = shouldReadIdentity
    ? await params.readProcessIdentityByPid(params.pid).catch(() => null)
    : null;
  const observedFingerprint = params.storedProcessInstanceFingerprint
    && params.runState !== 'dead' && params.runState !== 'zombie'
    ? params.readProcessInstanceFingerprint(params.pid, params.storedProcessInstanceFingerprint)
    : null;
  const observedCommandHash = params.runState === 'stopped' && currentIdentity?.command
    ? hashProcessCommand(currentIdentity.command)
    : undefined;
  return classifySessionRunnerProcessPresence({
    runState: params.runState,
    storedProcessStartTimeMs: params.storedProcessStartTimeMs,
    observedProcessStartTimeMs: currentIdentity?.processStartTimeMs,
    storedProcessInstanceFingerprint: params.storedProcessInstanceFingerprint,
    observedProcessInstanceFingerprint: observedFingerprint ?? undefined,
    storedProcessCommandHash: params.storedProcessCommandHash,
    observedProcessCommandHash: observedCommandHash,
  });
}

async function classifyLockPresence(params: {
  sessionId: string;
  readProcessRunState: ReadProcessRunState;
  readProcessIdentityByPid: typeof readProcessIdentityByPid;
  readProcessInstanceFingerprint: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}): Promise<SessionRunnerProcessPresence> {
  const status = await params.readSessionRunnerLockStatus({ sessionId: params.sessionId }).catch(() => null);
  if (!status) return 'unknown';
  if (!status.ok) return status.reason === 'not_found' ? 'absent' : 'unknown';

  const pid = status.lock.pid;
  const runState = await params.readProcessRunState(pid).catch(() => null);
  return await classifyStoredProcessPresence({
    runState,
    storedProcessStartTimeMs: status.lock.processStartTimeMs,
    storedProcessInstanceFingerprint: status.lock.processInstanceFingerprint,
    storedProcessCommandHash: status.lock.processCommandHash,
    pid,
    readProcessIdentityByPid: params.readProcessIdentityByPid,
    readProcessInstanceFingerprint: params.readProcessInstanceFingerprint,
  });
}

async function classifyTrackedSessionPresence(params: {
  sessionId: string;
  tracked: TrackedSession;
  readProcessRunState: ReadProcessRunState;
  readProcessIdentityByPid: typeof readProcessIdentityByPid;
  readProcessInstanceFingerprint: SessionRunnerProcessInstanceFingerprintReader;
}): Promise<SessionRunnerProcessPresence> {
  if (!trackedSessionMatchesSessionId(params.tracked, params.sessionId)) return 'absent';

  const childPid = typeof params.tracked.childProcess?.pid === 'number' ? params.tracked.childProcess.pid : null;
  const pidToCheck = childPid ?? params.tracked.pid;
  const runState = await params.readProcessRunState(pidToCheck).catch(() => null);
  return await classifyStoredProcessPresence({
    runState,
    storedProcessStartTimeMs: params.tracked.processStartTimeMs,
    storedProcessCommandHash: params.tracked.processCommandHash,
    pid: pidToCheck,
    readProcessIdentityByPid: params.readProcessIdentityByPid,
    readProcessInstanceFingerprint: params.readProcessInstanceFingerprint,
  });
}

export async function isSessionRunnerActive(params: Readonly<{
  sessionId: string;
  trackedSessions: Iterable<TrackedSession>;
  readProcessRunState?: ReadProcessRunState;
  readProcessIdentityByPid?: typeof readProcessIdentityByPid;
  readProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<boolean> {
  const sessionId = normalizeSessionId(params.sessionId);
  if (!sessionId) return false;

  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readProcessIdentity = params.readProcessIdentityByPid ?? readProcessIdentityByPid;
  const readProcessInstanceFingerprint = params.readProcessInstanceFingerprint
    ?? ((pid, expectedFingerprint) => readProcessInstanceFingerprintSync(pid, { expectedFingerprint }));
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;

  for (const tracked of params.trackedSessions) {
    if (await classifyTrackedSessionPresence({
      sessionId,
      tracked,
      readProcessRunState,
      readProcessIdentityByPid: readProcessIdentity,
      readProcessInstanceFingerprint,
    }) === 'present') return true;
  }

  return await classifyLockPresence({
    sessionId,
    readProcessRunState,
    readProcessIdentityByPid: readProcessIdentity,
    readProcessInstanceFingerprint,
    readSessionRunnerLockStatus: readLockStatus,
  }) === 'present';
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
  readProcessIdentityByPid?: typeof readProcessIdentityByPid;
  readProcessInstanceFingerprint?: SessionRunnerProcessInstanceFingerprintReader;
  readSessionRunnerLockStatus?: (args: { sessionId: string }) => Promise<SessionRunnerLockStatus>;
}>): Promise<SessionRunnerServiceabilityProbe> {
  const sessionId = normalizeSessionId(params.sessionId);
  const trackedSessions = Array.from(params.trackedSessions);
  const readProcessRunState = params.readProcessRunState ?? readProcessRunStateDefault;
  const readLockStatus = params.readSessionRunnerLockStatus ?? readSessionRunnerLockStatus;
  const readProcessIdentity = params.readProcessIdentityByPid ?? readProcessIdentityByPid;
  const readProcessInstanceFingerprint = params.readProcessInstanceFingerprint
    ?? ((pid, expectedFingerprint) => readProcessInstanceFingerprintSync(pid, { expectedFingerprint }));

  for (const tracked of trackedSessions) {
    if (!trackedSessionMatchesSessionId(tracked, sessionId)) continue;
    const presence = await classifyTrackedSessionPresence({
      sessionId,
      tracked,
      readProcessRunState,
      readProcessIdentityByPid: readProcessIdentity,
      readProcessInstanceFingerprint,
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
    readProcessIdentityByPid: readProcessIdentity,
    readProcessInstanceFingerprint,
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
