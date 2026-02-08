import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';

export function waitForVisibleConsoleSessionWebhook(params: Readonly<{
  pid: number;
  pollMs: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, ReturnType<typeof setTimeout>>;
  onChildExited: (pid: number, exit: ChildExit) => void;
}>): Promise<SpawnSessionResult> {
  const { pid, pollMs, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = params;
  return new Promise((resolve) => {
    pidToSpawnResultResolver.set(pid, resolve);
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

    const timeout = setTimeout(() => {
      clearInterval(interval);
      pidToAwaiter.delete(pid);
      pidToSpawnResultResolver.delete(pid);
      pidToSpawnWebhookTimeout.delete(pid);
      resolve({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: `Session webhook timeout for PID ${pid}`,
      });
    }, 15_000);
    pidToSpawnWebhookTimeout.set(pid, timeout);

    pidToAwaiter.set(pid, (completedSession) => {
      clearTimeout(timeout);
      pidToSpawnWebhookTimeout.delete(pid);
      pidToSpawnResultResolver.delete(pid);
      pidToAwaiter.delete(pid);

      const sessionId =
        typeof completedSession.happySessionId === 'string' ? completedSession.happySessionId.trim() : '';
      if (!sessionId) {
        resolve({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: `Session webhook did not include a sessionId (pid=${pid})`,
        });
        return;
      }
      resolve({
        type: 'success',
        sessionId,
      });
    });
  });
}
