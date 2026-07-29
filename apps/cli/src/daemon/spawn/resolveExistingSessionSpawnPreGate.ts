import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import type { TrackedSession } from '../types';

type ResolveExistingSessionSpawnPreGateResult = Readonly<{
  shortCircuitResult: SpawnSessionResult | null;
}>;

export type ExistingSessionAlreadyRunningDecision =
  | Readonly<{ action: 'use_existing' }>
  | Readonly<{ action: 'spawn_replacement' }>
  | Readonly<{ action: 'error'; result: Extract<SpawnSessionResult, { type: 'error' }> }>;

export async function resolveExistingSessionSpawnPreGate(params: Readonly<{
  existingSessionId: string | undefined;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  isSessionRunnerActive: (sessionId: string) => Promise<boolean>;
  waitForExitTimeoutMs: number;
  waitForExitPollIntervalMs: number;
  logDebug: (message: string, payload?: unknown) => void;
  onAlreadyRunning?: (sessionId: string) => Promise<ExistingSessionAlreadyRunningDecision | void>;
}>): Promise<ResolveExistingSessionSpawnPreGateResult> {
  const normalizedExistingSessionId = typeof params.existingSessionId === 'string' ? params.existingSessionId.trim() : '';
  if (!normalizedExistingSessionId) {
    return { shortCircuitResult: null };
  }

  const restartUnavailable = Array.from(params.pidToTrackedSession.values())
    .some((tracked) => (
      tracked.happySessionId?.trim() === normalizedExistingSessionId
      && tracked.agentRuntimeRestartDisposition
        === 'bridge_authority_unavailable'
    ));
  if (restartUnavailable) {
    return {
      shortCircuitResult: {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage:
          'The existing Agent runtime survived a daemon restart without reusable runtime authority. Retry after the existing runner has exited.',
      },
    };
  }

  const probeExistingSessionRunnerActive = async (): Promise<boolean> => {
    try {
      return await params.isSessionRunnerActive(normalizedExistingSessionId);
    } catch (error) {
      params.logDebug('[DAEMON RUN] Existing-session activity probe unavailable; continuing with attach spawn', {
        sessionId: normalizedExistingSessionId,
        error,
      });
      return false;
    }
  };

  if (!(await probeExistingSessionRunnerActive())) {
    return { shortCircuitResult: null };
  }

  if (params.waitForExitTimeoutMs > 0) {
    try {
      await waitForExistingSessionExitIfStopRequested({
        sessionId: normalizedExistingSessionId,
        pidToTrackedSession: params.pidToTrackedSession,
        isSessionRunnerActive: params.isSessionRunnerActive,
        timeoutMs: params.waitForExitTimeoutMs,
        pollIntervalMs: params.waitForExitPollIntervalMs,
      });
    } catch (error) {
      params.logDebug('[DAEMON RUN] Failed while waiting for an existing session to exit; continuing with attach spawn', {
        sessionId: normalizedExistingSessionId,
        error,
      });
    }
  }

  if (!(await probeExistingSessionRunnerActive())) {
    return { shortCircuitResult: null };
  }

  params.logDebug(`[DAEMON RUN] Resume requested for ${normalizedExistingSessionId}, but session is already running`);
  const decision = await params.onAlreadyRunning?.(normalizedExistingSessionId);
  if (decision?.action === 'spawn_replacement') {
    return { shortCircuitResult: null };
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
