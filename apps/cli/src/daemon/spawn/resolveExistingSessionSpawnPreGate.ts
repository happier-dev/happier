import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import type { TrackedSession } from '../types';

type ResolveExistingSessionSpawnPreGateResult = Readonly<{
  shortCircuitResult: SpawnSessionResult | null;
}>;

export async function resolveExistingSessionSpawnPreGate(params: Readonly<{
  existingSessionId: string | undefined;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  isSessionRunnerActive: (sessionId: string) => Promise<boolean>;
  waitForExitTimeoutMs: number;
  waitForExitPollIntervalMs: number;
  logDebug: (message: string, payload?: unknown) => void;
  onAlreadyRunning?: (sessionId: string) => Promise<void>;
}>): Promise<ResolveExistingSessionSpawnPreGateResult> {
  const normalizedExistingSessionId = typeof params.existingSessionId === 'string' ? params.existingSessionId.trim() : '';
  if (!normalizedExistingSessionId) {
    return { shortCircuitResult: null };
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
  await params.onAlreadyRunning?.(normalizedExistingSessionId);
  return {
    shortCircuitResult: {
      type: 'success',
      sessionId: normalizedExistingSessionId,
    },
  };
}
