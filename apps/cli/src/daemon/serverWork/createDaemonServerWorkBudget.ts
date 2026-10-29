import type { DaemonServerWorkBudget } from './types';

type QueueEntry<T> = {
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  removeAbortListener?: () => void;
};

function normalizeMaxConcurrentWrites(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function createTimeoutPromise(timeoutMs: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), Math.max(0, Math.floor(timeoutMs)));
    timeout.unref?.();
  });
}

export function createDaemonServerWorkBudget(
  params: Readonly<{ maxConcurrentWrites: number }>,
): DaemonServerWorkBudget {
  const maxConcurrentWrites = normalizeMaxConcurrentWrites(params.maxConcurrentWrites);
  const queue: QueueEntry<unknown>[] = [];
  const idleWaiters = new Set<() => void>();
  let activeCount = 0;

  function notifyIdleIfNeeded(): void {
    if (activeCount > 0 || queue.length > 0) return;
    for (const resolve of idleWaiters) {
      resolve();
    }
    idleWaiters.clear();
  }

  function drain(): void {
    while (activeCount < maxConcurrentWrites && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) continue;
      entry.removeAbortListener?.();
      activeCount += 1;
      void (async () => {
        try {
          entry.resolve(await entry.work());
        } catch (error) {
          entry.reject(error);
        } finally {
          activeCount -= 1;
          drain();
          notifyIdleIfNeeded();
        }
      })();
    }
  }

  return {
    run(metadata, work) {
      return new Promise((resolve, reject) => {
        const signal = metadata.signal;
        signal?.throwIfAborted();
        const entry: QueueEntry<unknown> = {
          work: work as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        };
        if (signal) {
          const abort = () => {
            const index = queue.indexOf(entry);
            if (index < 0) return;
            queue.splice(index, 1);
            entry.removeAbortListener?.();
            reject(signal.reason);
            notifyIdleIfNeeded();
          };
          signal.addEventListener('abort', abort, { once: true });
          entry.removeAbortListener = () => signal.removeEventListener('abort', abort);
        }
        queue.push(entry);
        drain();
      });
    },
    getSnapshot() {
      return { activeCount, queuedCount: queue.length, maxConcurrentWrites };
    },
    async awaitIdle(timeoutMs) {
      if (activeCount === 0 && queue.length === 0) return { timedOut: false };
      let resolveIdle!: () => void;
      const idle = new Promise<'idle'>((resolve) => {
        resolveIdle = () => resolve('idle');
      });
      idleWaiters.add(resolveIdle);
      const result = await Promise.race([idle, createTimeoutPromise(timeoutMs)]);
      idleWaiters.delete(resolveIdle);
      return { timedOut: result === 'timeout' };
    },
  };
}
