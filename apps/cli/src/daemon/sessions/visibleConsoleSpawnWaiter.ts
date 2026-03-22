import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';
import { waitForSessionWebhook } from '../spawn/waitForSessionWebhook';

export function waitForVisibleConsoleSessionWebhook(params: Readonly<{
  pid: number;
  pollMs: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, ReturnType<typeof setTimeout>>;
  onChildExited: (pid: number, exit: ChildExit) => void;
  resolveExistingSessionId?: () => string | null | undefined;
}>): Promise<SpawnSessionResult> {
  const { pid, pollMs, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = params;
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
  const interval = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(interval);
      const resolveSpawn = pidToSpawnResultResolver.get(pid);
      if (resolveSpawn) {
        pidToSpawnResultResolver.delete(pid);
        const timeout = pidToSpawnWebhookTimeout.get(pid);
        if (timeout) clearTimeout(timeout);
        pidToSpawnWebhookTimeout.delete(pid);
        pidToAwaiter.delete(pid);
        resolveSpawn({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
          errorMessage: `Child process exited before session webhook (pid=${pid})`,
        });
      }
      onChildExited(pid, { reason: 'process-exited', code: null, signal: null });
    }
  }, pollMs);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return waitForSessionWebhook({
    pid,
    pidToAwaiter,
    pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout,
    timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
    onTimeout: () => {
      clearInterval(interval);
    },
    resolveExistingSessionId: () => existingSessionId,
  });
}
