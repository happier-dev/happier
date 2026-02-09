import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

import type { TrackedSession } from '../types';

type WaitForSessionWebhookParams = {
  pid: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  timeoutMs?: number;
  timeoutErrorMessage: string;
  onTimeout?: () => void;
  onSuccess?: (session: TrackedSession) => void;
};

export function waitForSessionWebhook(
  params: WaitForSessionWebhookParams,
): Promise<SpawnSessionResult> {
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 15_000;

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
