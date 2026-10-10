import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import type { RunnerAgentSessionBootstrapAuthorization } from '../agentRuntime/sessionBridgeAuthorization';
import type { ChildExit } from '../sessions/onChildExited';
import { resolveSpawnWebhookResult } from '../sessions/resolveSpawnWebhookResult';
import type { RunnerAgentInvocationContext, TrackedSession } from '../types';
import type { SpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import type { PersistedTakeoverAdmissionWaitRegistration } from './persistedTakeoverAdmission';
import {
  completeStartupCancellationCleanup,
  resolveSpawnErrorAfterStartupCancellation,
  type CancelStartupLaunch,
} from './startupLaunchCancellation';
import { armSessionWebhookStartupCustody, waitForSessionWebhook } from './waitForSessionWebhook';

export async function waitForTerminalHostedSessionWebhook(params: Readonly<{
  pid: number;
  label: string;
  normalizedExistingSessionId: string;
  trackedSpawnOptions: SpawnSessionOptions;
  sessionCreationOutcome?: TrackedSession['sessionCreationOutcome'];
  effectiveResume: string;
  directoryCreated: boolean;
  message?: string;
  trackedSessionFields?: Partial<Pick<TrackedSession, 'tmuxSessionId' | 'tmuxTmpDir' | 'hostedTerminal'>>;
  runnerAgentSessionBootstrapAuthorization?: RunnerAgentSessionBootstrapAuthorization | null;
  runnerAgentInvocationContext?: RunnerAgentInvocationContext | null;
  pidToTrackedSession: Map<number, TrackedSession>;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
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
  const trackedSession: TrackedSession = {
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
        pidToTrackedSession: params.pidToTrackedSession,
        onChildExited: params.onChildExited,
      });
    })();
    return startupLaunchCancellation;
  };
  trackedSession.cancelStartupLaunchBeforeAck = cancelStartupLaunch;

  params.pidToTrackedSession.set(params.pid, trackedSession);
  params.spawnLifecycleCallbacks.onTrackedSessionRegistered?.();
  params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid(trackedSession.pid);
  params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid(trackedSession.pid);
  const acceptedSpawnMarkerPromise = params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker(trackedSession);
  params.logDebug(`[DAEMON RUN] Waiting for session webhook for PID ${params.pid} (${params.label})`);
  const spawnResultPromise = waitForSessionWebhook({
    pid: params.pid,
    pidToAwaiter: params.pidToAwaiter,
    takeoverAdmission: params.takeoverAdmission,
    pidToSpawnResultResolver: params.pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
    pidToTrackedSession: params.pidToTrackedSession,
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
    const timeout = params.pidToSpawnWebhookTimeout.get(params.pid);
    if (timeout) clearTimeout(timeout);
    params.pidToSpawnWebhookTimeout.delete(params.pid);
    params.pidToAwaiter.delete(params.pid);
    params.pidToSpawnResultResolver.delete(params.pid);
    if (params.pidToTrackedSession.get(trackedSession.pid) === trackedSession) {
      const incompleteRetirement = resolveSpawnErrorAfterStartupCancellation(await cancelStartupLaunch());
      if (incompleteRetirement) throw new Error(incompleteRetirement);
    }
    throw error;
  }
  params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget(trackedSession.pid);
  trackedSession.acceptedSpawnMarkerGate = undefined;
  resolveAcceptedSpawnMarker(true);

  let spawnResult = await spawnResultPromise.then((result) => resolveSpawnWebhookResult({
    pid: params.pid,
    result,
    pidToTrackedSession: params.pidToTrackedSession,
    warn: params.warn,
  }));
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
    }
  }
  if (spawnResult.type === 'success') delete trackedSession.cancelStartupLaunchBeforeAck;
  return spawnResult;
}
