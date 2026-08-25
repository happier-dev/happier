import { isPidPresent } from '@happier-dev/cli-common/process';

import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';
import { waitForSessionWebhook } from '../spawn/waitForSessionWebhook';

export function waitForVisibleConsoleSessionWebhook(params: Readonly<{
  pid: number;
  pollMs: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, ReturnType<typeof setTimeout>>;
  pidToTrackedSession?: Map<number, TrackedSession>;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
}>): Promise<SpawnSessionResult> {
  const { pid, pollMs, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = params;
  let exitObserved = false;
  const interval = setInterval(() => {
    // Only proof of absence retires the session. A pid we may not signal is still running, and
    // reporting `process-exited` for it would tear down a live console session.
    if (isPidPresent(pid)) return;
    if (exitObserved) return;
    exitObserved = true;
    clearInterval(interval);
    const resolveSpawn = pidToSpawnResultResolver.get(pid);
    const exitedBeforeWebhook = typeof resolveSpawn === 'function';
    if (resolveSpawn) {
      pidToSpawnResultResolver.delete(pid);
      const timeout = pidToSpawnWebhookTimeout.get(pid);
      if (timeout) clearTimeout(timeout);
      pidToSpawnWebhookTimeout.delete(pid);
      pidToAwaiter.delete(pid);
    }
    void (async () => {
      try {
        await onChildExited(pid, {
          reason: exitedBeforeWebhook
            ? 'process-exited-before-webhook'
            : 'process-exited',
          code: null,
          signal: null,
        });
      } catch {
        resolveSpawn?.({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorMessage:
            'startup_retirement_incomplete:exit_cleanup_incomplete',
        });
        return;
      }
      resolveSpawn?.({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage:
          `Child process exited before session webhook (pid=${pid})`,
      });
    })();
  }, pollMs);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return waitForSessionWebhook({
    pid,
    pidToAwaiter,
    pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout,
    pidToTrackedSession: params.pidToTrackedSession,
    timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
    onTimeout: () => {
      clearInterval(interval);
    },
  });
}
