import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import type { RunnerAgentSessionBootstrapAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import type { ChildExit } from '../sessions/onChildExited';
import type { RunnerAgentInvocationContext, TrackedSession } from '../types';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import {
  completeStartupCancellationCleanup,
  resolveSpawnErrorAfterStartupCancellation,
  projectRetiredStartupLaunchResult,
  type CancelStartupLaunch,
} from './startupLaunchCancellation';
import { armSessionWebhookStartupCustody, waitForSessionWebhook } from './waitForSessionWebhook';
import {
  isCurrentTrackedSession,
  mintSessionTrackingKey,
  trackSession,
  type SessionTrackingKey,
  type TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';

export async function waitForTerminalHostedSessionWebhook(params: Readonly<{
  pid: number;
  label: string;
  normalizedExistingSessionId: string;
  trackedSpawnOptions: SpawnSessionOptions;
  sessionCreationOutcome?: TrackedSession['sessionCreationOutcome'];
  effectiveResume: string;
  directoryCreated: boolean;
  message?: string;
  trackedSessionFields?: Partial<Pick<TrackedSession, 'tmuxSessionId' | 'tmuxTmpDir' | 'hostedTerminal' | 'linuxLaunchUnit'>>;
  runnerAgentSessionBootstrapAuthorization?: RunnerAgentSessionBootstrapAuthorization | null;
  runnerAgentInvocationContext?: RunnerAgentInvocationContext | null;
  trackedSessionsByKey: TrackedSessionMap;
  spawnAwaiterByKey: Map<SessionTrackingKey, (session: TrackedSession) => void>;
  spawnResultResolverByKey: Map<SessionTrackingKey, (result: SpawnSessionResult) => void>;
  spawnWebhookTimeoutByKey: Map<SessionTrackingKey, NodeJS.Timeout>;
  takeoverAdmission?: PersistedTakeoverAdmissionWaitRegistration;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
  spawnLifecycleCallbacks: SpawnLifecycleCallbacks;
  cleanupSpawnResources: () => void | Promise<void>;
  cancelOwnedHost: () => Promise<boolean>;
  bindCanonicalSession: (sessionId: string) => Promise<void>;
  logDebug: (message: string, payload?: unknown) => void;
  warn: (message: string) => void;
  sanitizeDiagnosticText?: (value: string) => string;
}>): Promise<SpawnSessionResult> {
  const sanitizeDiagnosticText = params.sanitizeDiagnosticText ?? ((value: string) => value);
  let resolveAcceptedSpawnMarker!: (accepted: boolean) => void;
  const acceptedSpawnMarkerGate = new Promise<boolean>((resolve) => {
    resolveAcceptedSpawnMarker = resolve;
  });
  const trackingKey = mintSessionTrackingKey();
  const trackedSession: TrackedSession = {
    trackingKey,
    startedBy: 'daemon',
    happySessionId: params.normalizedExistingSessionId || `PID-${params.pid}`,
    pid: params.pid,
    spawnOptions: params.trackedSpawnOptions,
    ...(params.sessionCreationOutcome ? { sessionCreationOutcome: params.sessionCreationOutcome } : {}),
    acceptedSpawnMarkerGate,
    ...(params.runnerAgentSessionBootstrapAuthorization ? {
      agentRuntimeDaemonServiceAuthorityFilePath: params.runnerAgentSessionBootstrapAuthorization.authorityFilePath,
      runnerAgentBootstrapIdentity: {
        agentId: params.runnerAgentSessionBootstrapAuthorization.descriptor.agentId,
        backendId: params.runnerAgentSessionBootstrapAuthorization.descriptor.backendId,
      },
    } : {}),
    ...(params.runnerAgentInvocationContext ? { runnerAgentInvocationContext: params.runnerAgentInvocationContext } : {}),
    ...(params.trackedSessionFields ?? {}),
    vendorResumeId: params.effectiveResume || undefined,
    directoryCreated: params.directoryCreated,
    ...(params.message ? { message: params.message } : {}),
  };
  let startupLaunchCancellation: ReturnType<CancelStartupLaunch> | null = null;
  const cancelStartupLaunch: CancelStartupLaunch = () => {
    startupLaunchCancellation ??= (async () => {
      try {
        await params.cleanupSpawnResources();
      } catch {
        return { status: 'incomplete' as const, reason: 'exit_cleanup_incomplete' as const };
      }
      if (!await params.cancelOwnedHost()) {
        return { status: 'incomplete' as const, reason: 'terminal_host_disposition_failed' as const };
      }
      return await completeStartupCancellationCleanup({
        trackedSession,
        wrapperPid: params.pid,
        trackedSessionsByKey: params.trackedSessionsByKey,
        onChildExited: params.onChildExited,
      });
    })();
    return startupLaunchCancellation;
  };
  trackedSession.cancelStartupLaunchBeforeAck = cancelStartupLaunch;

  trackSession(params.trackedSessionsByKey, trackedSession);
  params.spawnLifecycleCallbacks.onTrackedSessionRegistered?.(trackedSession);
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForSession(trackedSession.trackingKey);
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForSession(trackedSession.trackingKey);
  const acceptedSpawnMarkerPromise = params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker(trackedSession);
  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${params.pid} (${params.label})`);
  const spawnResultPromise = waitForSessionWebhook({
    trackingKey,
    pid: params.pid,
    spawnAwaiterByKey: params.spawnAwaiterByKey,
    takeoverAdmission: params.takeoverAdmission,
    spawnResultResolverByKey: params.spawnResultResolverByKey,
    spawnWebhookTimeoutByKey: params.spawnWebhookTimeoutByKey,
    trackedSessionsByKey: params.trackedSessionsByKey,
    timeoutErrorMessage: `Session webhook timeout for PID ${params.pid} (${params.label})`,
    onTimeout: () => params.logDebug(`[DAEMON RUN] Session webhook timeout for PID ${params.pid} (${params.label})`),
    onSuccess: async (completedSession) => {
      await acceptedSpawnMarkerPromise;
      if (trackedSession.spawnStartupReadinessFailure) {
        throw new Error(trackedSession.spawnStartupReadinessFailure.errorMessage);
      }
      params.logDebug(`[DAEMON RUN] Session fully spawned with webhook (${params.label})`);
      const sessionId = completedSession.happySessionId?.trim() ?? '';
      if (!sessionId) throw new Error('canonical_session_id_missing');
      try {
        await params.bindCanonicalSession(sessionId);
      } catch (error) {
        params.logDebug(
          `[DAEMON RUN] Failed to bind the spawned ${params.label} host to its canonical session`,
          sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
        );
        trackedSession.spawnStartupReadinessFailure ??= {
          type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorMessage: 'terminal_attachment_binding_failed',
        };
        throw new Error('terminal_attachment_binding_failed');
      }
    },
  });
  armSessionWebhookStartupCustody(trackedSession, spawnResultPromise, acceptedSpawnMarkerPromise);
  try {
    await acceptedSpawnMarkerPromise;
  } catch (error) {
    params.logDebug(
      `[DAEMON RUN] Failed to persist accepted spawn marker for PID ${params.pid} (${params.label})`,
      sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
    );
    resolveAcceptedSpawnMarker(false);
    const timeout = params.spawnWebhookTimeoutByKey.get(trackingKey);
    if (timeout) clearTimeout(timeout);
    params.spawnWebhookTimeoutByKey.delete(trackingKey);
    params.spawnAwaiterByKey.delete(trackingKey);
    params.spawnResultResolverByKey.delete(trackingKey);
    if (isCurrentTrackedSession(params.trackedSessionsByKey, trackedSession)) {
      const incompleteRetirement = resolveSpawnErrorAfterStartupCancellation(await cancelStartupLaunch());
      if (incompleteRetirement) throw new Error(incompleteRetirement);
    }
    throw error;
  }
  params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(trackedSession.pid, trackedSession.trackingKey);
  trackedSession.acceptedSpawnMarkerGate = undefined;
  resolveAcceptedSpawnMarker(true);

  let spawnResult = await spawnResultPromise;
  if (spawnResult.type === 'error' && (
    trackedSession.spawnStartupReadinessFailure
    || typeof trackedSession.sessionWebhookTimedOutAtMs === 'number'
  )) {
    const incompleteRetirement = resolveSpawnErrorAfterStartupCancellation(await cancelStartupLaunch());
    if (incompleteRetirement) {
      spawnResult = {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: incompleteRetirement,
      };
    } else {
      spawnResult = projectRetiredStartupLaunchResult({ result: spawnResult,
        readinessFailure: trackedSession.spawnStartupReadinessFailure,
        spawnNonce: params.trackedSpawnOptions.spawnNonce, wrapperPid: params.pid });
    }
  }
  if (spawnResult.type === 'success') delete trackedSession.cancelStartupLaunchBeforeAck;
  return spawnResult;
}
