import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

import type { TrackedSession } from '../types';

const DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS = 90_000;
const SESSION_WEBHOOK_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS';

type WaitForSessionWebhookParams = {
  pid: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  timeoutMs?: number;
  timeoutErrorMessage: string;
  onTimeout?: () => void;
  onSuccess?: (session: TrackedSession) => void;
  resolveExistingSessionId?: () => string | null | undefined;
};

function resolveTimeoutMs(explicitTimeoutMs: number | undefined): number {
  if (typeof explicitTimeoutMs === 'number' && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }

  const rawEnvValue = String(process.env[SESSION_WEBHOOK_TIMEOUT_ENV_KEY] ?? '').trim();
  if (!rawEnvValue) {
    return DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawEnvValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
  }

  return parsed;
}

export function waitForSessionWebhook(
  params: WaitForSessionWebhookParams,
): Promise<SpawnSessionResult> {
  const existingSessionId =
    typeof params.resolveExistingSessionId === 'function'
      ? String(params.resolveExistingSessionId() ?? '').trim()
      : '';
  if (existingSessionId) {
    return Promise.resolve({
      type: 'success',
      sessionId: existingSessionId,
    });
  }

  const timeoutMs = resolveTimeoutMs(params.timeoutMs);

  return new Promise((resolve) => {
    const clearTrackedState = () => {
      params.pidToAwaiter.delete(params.pid);
      params.pidToSpawnResultResolver.delete(params.pid);
      params.pidToSpawnWebhookTimeout.delete(params.pid);
    };

    params.pidToSpawnResultResolver.set(params.pid, resolve);

    const timeout = setTimeout(() => {
      clearTrackedState();
      params.onTimeout?.();
      resolve({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: params.timeoutErrorMessage,
      });
    }, timeoutMs);

    params.pidToSpawnWebhookTimeout.set(params.pid, timeout);

    params.pidToAwaiter.set(params.pid, (completedSession) => {
      clearTimeout(timeout);
      clearTrackedState();
      params.onSuccess?.(completedSession);
      resolve({
        type: 'success',
        sessionId: completedSession.happySessionId!,
      });
    });
  });
}
