export type KeyedSingleFlightScheduler = {
  schedule: (key: string, run: () => Promise<void>) => void;
  scheduleResult: <T>(key: string, run: () => Promise<T>) => Promise<T>;
  cancel: (key: string) => void;
};

type DeferredResult = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type Entry = {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  queued: boolean;
  pendingRun: (() => Promise<void>) | null;
  result: DeferredResult | null;
};

export function createKeyedSingleFlightScheduler(params: Readonly<{ delayMs: number; maxConcurrent?: number }>): KeyedSingleFlightScheduler {
  const entries = new Map<string, Entry>();
  const readyQueue: string[] = [];
  const maxConcurrent = (() => {
    const value = params.maxConcurrent;
    if (typeof value !== 'number') return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.floor(value));
  })();
  let activeCount = 0;

  function getOrCreateEntry(key: string): Entry {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: Entry = { timer: null, inFlight: null, queued: false, pendingRun: null, result: null };
    entries.set(key, created);
    return created;
  }

  function createDeferredResult(): DeferredResult {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function maybeDeleteEntry(key: string, entry: Entry): void {
    if (entry.timer) return;
    if (entry.inFlight) return;
    if (entry.queued) return;
    if (entry.pendingRun) return;
    entries.delete(key);
  }

  function dequeueKey(key: string): void {
    const idx = readyQueue.indexOf(key);
    if (idx < 0) return;
    readyQueue.splice(idx, 1);
  }

  function drainQueue(): void {
    while (activeCount < maxConcurrent && readyQueue.length > 0) {
      const key = readyQueue.shift();
      if (!key) continue;
      const entry = entries.get(key);
      if (!entry) continue;
      entry.queued = false;
      if (entry.timer || entry.inFlight || !entry.pendingRun) {
        maybeDeleteEntry(key, entry);
        continue;
      }
      startRunIfCapacity(key, entry);
    }
  }

  function startRunIfCapacity(key: string, entry: Entry): void {
    if (entry.inFlight) return;
    const run = entry.pendingRun;
    if (!run) {
      maybeDeleteEntry(key, entry);
      return;
    }

    if (activeCount >= maxConcurrent) {
      if (!entry.queued) {
        entry.queued = true;
        readyQueue.push(key);
      }
      return;
    }

    entry.pendingRun = null;
    activeCount += 1;
    const p = (async () => {
      try {
        await run();
      } catch {
        // The scheduler is a coalescing primitive; callers own result/error reporting.
      }
    })();

    entry.inFlight = p.finally(() => {
      activeCount -= 1;
      entry.inFlight = null;
      entry.result = null;
      maybeDeleteEntry(key, entry);
      drainQueue();
    });
  }

  return {
    schedule(key, run) {
      if (!key) return;
      const entry = getOrCreateEntry(key);
      if (entry.timer || entry.inFlight || entry.queued || entry.pendingRun) return;

      entry.pendingRun = run;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        startRunIfCapacity(key, entry);
      }, params.delayMs);
      entry.timer.unref?.();
    },

    scheduleResult(key, run) {
      if (!key) return Promise.reject(new Error('Scheduler key is required'));
      const entry = getOrCreateEntry(key);
      if (entry.result) return entry.result.promise as Promise<Awaited<ReturnType<typeof run>>>;
      if (entry.timer || entry.inFlight || entry.queued || entry.pendingRun) {
        return Promise.reject(new Error('Scheduler key is already reserved by a void run'));
      }

      const result = createDeferredResult();
      entry.result = result;
      entry.pendingRun = async () => {
        try {
          result.resolve(await run());
        } catch (error) {
          result.reject(error);
        }
      };
      entry.timer = setTimeout(() => {
        entry.timer = null;
        startRunIfCapacity(key, entry);
      }, params.delayMs);
      entry.timer.unref?.();
      return result.promise as Promise<Awaited<ReturnType<typeof run>>>;
    },

    cancel(key) {
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.queued) {
        entry.queued = false;
        dequeueKey(key);
      }
      entry.pendingRun = null;
      if (!entry.inFlight && entry.result) {
        entry.result.reject(new Error('Scheduled run was canceled'));
        entry.result = null;
      }
      maybeDeleteEntry(key, entry);
    },
  };
}
