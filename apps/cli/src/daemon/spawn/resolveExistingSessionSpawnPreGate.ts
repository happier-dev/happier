import { isPidPlaceholderSessionId } from '../sessionRegistry';
import { extractResumeIdFromCommand } from '../sessions/extractResumeIdFromCommand';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import type { TrackedSession } from '../types';
import { classifyTrackedSessionProcessPresence, type SessionRunnerPresenceProbe } from '../sessions/isSessionRunnerActive';
import type { Metadata } from '@/api/types';
import type { ProcessCensusProcessFact } from '@/processes/census/processFacts';
import { hashProcessCommand, processIdentityMatches } from '@happier-dev/cli-common/processInstance';
import { readProcessIdentityByPid } from '../processIdentity';
import { readProcessRunState } from '../processRunState';
import { adoptTrackedSessionRunnerIdentity, bindTrackedSessionIdentity, resolveSessionReportTrackedCorrelation } from '../sessions/sessionReportCorrelation';
import { isCurrentTrackedSession, type ReadonlyTrackedSessionMap, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

type PendingSessionStartup = Readonly<{
  spawnAwaiterByKey: ReadonlyMap<SessionTrackingKey, unknown>;
  machineId: string;
  happyHomeDir: string;
  readSessionMetadata: (sessionId: string) => Promise<Metadata | null>;
  readProcessRunState?: typeof readProcessRunState;
  readProcessIdentityByPid?: typeof readProcessIdentityByPid;
  readAllWindowsProcessFactsFn?: () => Promise<ReadonlyMap<number, ProcessCensusProcessFact>>;
}>;

function isPendingStartup(tracked: TrackedSession, params: Readonly<{
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  pendingSessionStartup?: PendingSessionStartup;
}>): boolean {
  return tracked.startedBy === 'daemon'
    && isCurrentTrackedSession(params.trackedSessionsByKey, tracked)
    && params.pendingSessionStartup?.spawnAwaiterByKey.has(tracked.trackingKey) === true
    && !tracked.reportMarkerCustody?.retiring
    && tracked.sessionWebhookTimedOutAtMs === undefined
    && !tracked.spawnStartupReadinessFailure;
}

function isUnboundPendingStartup(tracked: TrackedSession, params: Readonly<{
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  pendingSessionStartup?: PendingSessionStartup;
}>): boolean {
  return isPendingStartup(tracked, params)
    && !tracked.spawnOptions?.existingSessionId?.trim()
    && (!tracked.happySessionId?.trim() || isPidPlaceholderSessionId(tracked.happySessionId.trim()))
    && !tracked.spawnStartupCanonicalSessionId;
}

async function associatePendingFreshStartup(params: Readonly<{
  sessionId: string;
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  pendingSessionStartup?: PendingSessionStartup;
  logWarn: (message: string, payload?: unknown) => void;
}>): Promise<SessionRunnerPresenceProbe | null> {
  const startup = params.pendingSessionStartup;
  const isUnbound = (tracked: TrackedSession) => isUnboundPendingStartup(tracked, params);
  if (!startup || ![...params.trackedSessionsByKey.values()].some(isUnbound)) return null;
  let metadata: Metadata | null;
  try {
    metadata = await startup.readSessionMetadata(params.sessionId);
  } catch {
    if (![...params.trackedSessionsByKey.values()].some(isUnbound)) return null;
    params.logWarn('[DAEMON RUN] Existing-session startup metadata unavailable; refusing duplicate launch');
    return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  }
  if (!metadata || metadata.machineId !== startup.machineId
    || metadata.happyHomeDir !== startup.happyHomeDir || metadata.startedBy !== 'daemon'
    || !Number.isInteger(metadata.hostPid) || (metadata.hostPid ?? 0) <= 0) return null;
  const readIdentity = startup.readProcessIdentityByPid ?? readProcessIdentityByPid;
  const correlation = await resolveSessionReportTrackedCorrelation({
    metadata, pid: metadata.hostPid!, trackedSessionsByKey: params.trackedSessionsByKey,
    spawnAwaiterByKey: startup.spawnAwaiterByKey, readProcessIdentityByPidFn: readIdentity,
    readAllWindowsProcessFactsFn: startup.readAllWindowsProcessFactsFn,
  });
  if (correlation.kind === 'refused') return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  if (correlation.kind !== 'matched' || !isUnbound(correlation.tracked)) return null;
  const tracked = correlation.tracked;
  const generation = metadata.hostProcessStartTimeMs;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    params.logWarn('[DAEMON RUN] Pending fresh-session metadata has no process generation; refusing duplicate launch');
    return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  }
  const exactWindowsIdentity = 'cancellationIdentity' in correlation ? correlation.cancellationIdentity : undefined;
  const identity = exactWindowsIdentity ?? await readIdentity(metadata.hostPid!).catch(() => null);
  if (!isUnbound(tracked)) return null;
  if (!identity || identity.processStartTimeMs === undefined) {
    params.logWarn('[DAEMON RUN] Pending fresh-session process generation unavailable; refusing duplicate launch');
    return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  }
  if (!processIdentityMatches({ pid: metadata.hostPid!, processStartTimeMs: generation }, identity)) return null;
  const runnerIdentity = exactWindowsIdentity ?? ('command' in identity && identity.command.trim()
    ? { pid: identity.pid, processStartTimeMs: identity.processStartTimeMs, processCommandHash: hashProcessCommand(identity.command) }
    : null);
  if (!runnerIdentity) {
    params.logWarn('[DAEMON RUN] Pending fresh-session runner identity unavailable; refusing duplicate launch');
    return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  }
  adoptTrackedSessionRunnerIdentity(tracked, runnerIdentity);
  const presence = await classifyTrackedSessionProcessPresence({
    tracked, readProcessRunState: startup.readProcessRunState ?? readProcessRunState,
    readProcessIdentityByPid: readIdentity,
  });
  if (!isUnbound(tracked)) return null;
  if (presence === 'absent') return null;
  if (presence !== 'present') return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
  bindTrackedSessionIdentity(tracked, params.sessionId);
  return { state: 'runner_present' };
}

type ResolveExistingSessionSpawnPreGateResult = Readonly<{
  shortCircuitResult: SpawnSessionResult | null;
}>;

export type ExistingSessionAlreadyRunningDecision =
  | Readonly<{ action: 'use_existing' }>
  | Readonly<{
      action: 'wait_for_exit';
      timeoutResult: Extract<SpawnSessionResult, { type: 'error' }>;
    }>
  | Readonly<{ action: 'error'; result: Extract<SpawnSessionResult, { type: 'error' }> }>;

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

export async function resolveExistingSessionSpawnPreGate(params: Readonly<{
  existingSessionId: string | undefined;
  providerConversation?: Readonly<{ backendTarget: BackendTargetRefV2; resumeId: string }>;
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  probeSessionRunnerPresence: (sessionId: string) => Promise<SessionRunnerPresenceProbe>;
  waitForExitTimeoutMs: number;
  waitForExitPollIntervalMs: number;
  logDebug: (message: string, payload?: unknown) => void;
  logWarn: (message: string, payload?: unknown) => void;
  pendingSessionStartup?: PendingSessionStartup;
  onAlreadyRunning?: (sessionId: string) => Promise<ExistingSessionAlreadyRunningDecision | void>;
}>): Promise<ResolveExistingSessionSpawnPreGateResult> {
  const normalizedExistingSessionId = typeof params.existingSessionId === 'string' ? params.existingSessionId.trim() : '';
  const conversation = params.providerConversation;
  if (conversation?.resumeId) {
    const targetKey = buildBackendTargetKeyV2(conversation.backendTarget);
    for (const tracked of params.trackedSessionsByKey.values()) {
      const siblingId = tracked.happySessionId ?? tracked.spawnOptions?.existingSessionId;
      if (!siblingId || siblingId === normalizedExistingSessionId) continue;
      // Terminal registration can precede the provider-id metadata report.
      const trackedResumeId = tracked.vendorResumeId ?? tracked.spawnOptions?.resume
        ?? extractResumeIdFromCommand(tracked.processCommand ?? '');
      if (trackedResumeId !== conversation.resumeId) continue;
      const target = tracked.spawnOptions?.agentTarget ?? tracked.spawnOptions?.backendTarget
        ?? resolveBackendTargetFromSessionMetadata(tracked.happySessionMetadataFromLocalWebhook);
      if (!target || buildBackendTargetKeyV2(target) !== targetKey) continue;
      const presence = await params.probeSessionRunnerPresence(siblingId);
      if (presence.state === 'runner_absent') continue;
      params.logWarn('[DAEMON RUN] Refusing a second entry for an existing provider conversation', { presence: presence.state });
      return { shortCircuitResult: {
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'This conversation already has another session runner. Open its existing session, or stop that runner before resuming.',
      } };
    }
  }
  if (!normalizedExistingSessionId) {
    return { shortCircuitResult: null };
  }

  const restartUnavailable = Array.from(params.trackedSessionsByKey.values())
    .some((tracked) => (
      tracked.happySessionId?.trim() === normalizedExistingSessionId
      && tracked.agentRuntimeRunnerRestartDisposition
        === 'runner_authority_unavailable'
    ));
  if (restartUnavailable) {
    return {
      shortCircuitResult: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        runtimeFailureReason: 'runner_authority_unavailable',
        errorMessage:
          'The existing Agent runtime survived a daemon restart without reusable runtime authority. Retry after the existing runner has exited.',
      },
    };
  }

  const unknownPresenceResult: ResolveExistingSessionSpawnPreGateResult = {
    shortCircuitResult: {
      type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      runtimeFailureReason: 'runner_presence_unproven',
      errorMessage: 'The existing session runtime could not be verified. Retry resume after connectivity recovers.',
    },
  };
  const refuseUnknownPresence = (): ResolveExistingSessionSpawnPreGateResult => {
    params.logWarn('[DAEMON RUN] Existing-session process presence unproven; refusing duplicate launch');
    return unknownPresenceResult;
  };
  const probeExistingSessionPresence = async (): Promise<SessionRunnerPresenceProbe> => {
    try {
      return await params.probeSessionRunnerPresence(normalizedExistingSessionId);
    } catch {
      params.logWarn('[DAEMON RUN] Existing-session process presence unavailable; refusing duplicate launch');
      return { state: 'runner_unknown', reason: 'runner_presence_unproven' };
    }
  };
  let initialPresence = await probeExistingSessionPresence();
  if (initialPresence.state === 'runner_absent'
    && [...params.trackedSessionsByKey.values()].some((tracked) => isUnboundPendingStartup(tracked, params))) {
    try {
      const associated = await associatePendingFreshStartup({
        sessionId: normalizedExistingSessionId, trackedSessionsByKey: params.trackedSessionsByKey,
        pendingSessionStartup: params.pendingSessionStartup, logWarn: params.logWarn,
      });
      initialPresence = associated?.state === 'runner_unknown' ? associated : await probeExistingSessionPresence();
    } catch {
      params.logWarn('[DAEMON RUN] Pending fresh-session correlation unavailable; refusing duplicate launch');
      initialPresence = { state: 'runner_unknown', reason: 'runner_presence_unproven' };
    }
  }
  if (initialPresence.state === 'runner_unknown') return refuseUnknownPresence();
  if (initialPresence.state === 'runner_absent') return { shortCircuitResult: null };
  const pendingAccepted = [...params.trackedSessionsByKey.values()].some((tracked) =>
    isPendingStartup(tracked, params)
    && (tracked.happySessionId?.trim() === normalizedExistingSessionId
      || tracked.spawnOptions?.existingSessionId?.trim() === normalizedExistingSessionId)
    && typeof tracked.stopRequestedAtMs !== 'number');
  if (pendingAccepted) return { shortCircuitResult: { type: 'success', sessionId: normalizedExistingSessionId } };

  const waitStartedAtMs = Date.now();
  const waitBudgetMs = Math.max(0, params.waitForExitTimeoutMs);
  const remainingWaitMs = (): number => Math.max(0, waitBudgetMs - (Date.now() - waitStartedAtMs));

  if (waitBudgetMs > 0) {
    try {
      await waitForExistingSessionExitIfStopRequested({
        sessionId: normalizedExistingSessionId,
        trackedSessionsByKey: params.trackedSessionsByKey,
        timeoutMs: remainingWaitMs(),
        pollIntervalMs: params.waitForExitPollIntervalMs,
      });
    } catch {
      params.logWarn('[DAEMON RUN] Failed while waiting for an existing session to exit; rechecking process presence');
    }
  }

  const presenceAfterStopWait = await probeExistingSessionPresence();
  if (presenceAfterStopWait.state === 'runner_unknown') return refuseUnknownPresence();
  if (presenceAfterStopWait.state === 'runner_absent') return { shortCircuitResult: null };

  params.logDebug('[DAEMON RUN] Resume target is already running');
  let decision = await params.onAlreadyRunning?.(normalizedExistingSessionId);
  while (decision?.action === 'wait_for_exit' && remainingWaitMs() > 0) {
    await sleep(Math.min(
      Math.max(1, params.waitForExitPollIntervalMs),
      remainingWaitMs(),
    ));
    const currentPresence = await probeExistingSessionPresence();
    if (currentPresence.state === 'runner_unknown') return refuseUnknownPresence();
    if (currentPresence.state === 'runner_absent') return { shortCircuitResult: null };
    decision = await params.onAlreadyRunning?.(normalizedExistingSessionId);
  }
  if (decision?.action === 'wait_for_exit') {
    return { shortCircuitResult: decision.timeoutResult };
  }
  if (decision?.action === 'error') {
    return { shortCircuitResult: decision.result };
  }
  return {
    shortCircuitResult: {
      type: 'success',
      sessionId: normalizedExistingSessionId,
    },
  };
}
