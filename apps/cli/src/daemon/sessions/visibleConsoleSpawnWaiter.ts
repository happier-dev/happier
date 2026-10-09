import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';
import { waitForSessionWebhook, type SessionWebhookCompletion } from '../spawn/waitForSessionWebhook';
import { logger } from '@/ui/logger';

export function waitForVisibleConsoleSessionWebhook(params: Readonly<{
  pid: number;
  pollMs: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, ReturnType<typeof setTimeout>>;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
  onSuccess?: (session: TrackedSession) => void | Promise<void>;
}>): SessionWebhookCompletion {
  const { pollMs, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = params;
  let completion: SessionWebhookCompletion;
  const interval = setInterval(() => {
    const pid = completion.getCurrentPid();
    try {
      process.kill(pid, 0);
    } catch {
      // The canonical exit owner arbitrates runner presence and wrapper promotion.
      // Do not fail the same waiter or stop its existing poll for a wrapper-only exit.
      let retirement: void | Promise<void>;
      try {
        retirement = onChildExited(pid, { reason: 'process-missing', code: null, signal: null });
      } catch (error) {
        retirement = Promise.reject(error);
      }
      // The exit owner settles startup through its custody finalizer. A poll
      // observes PID absence only; it must not retire a retained dispatcher or
      // independently fail the same waiter. Keep polling after promotion.
      void Promise.resolve(retirement).then(() => {
        if (completion.getCurrentPid() === pid && !pidToSpawnResultResolver.has(pid)) clearInterval(interval);
      }, (error) => {
        logger.warn('[DAEMON RUN] Failed to complete visible-console exit cleanup; retaining tracked custody', { pid, error });
      });
    }
  }, pollMs);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  completion = waitForSessionWebhook({
    pid: params.pid,
    pidToAwaiter,
    pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout,
    timeoutErrorMessage: `Session webhook timeout for PID ${params.pid}`,
    onTimeout: () => {
      clearInterval(interval);
    },
    onSuccess: params.onSuccess,
  });
  return completion;
}
