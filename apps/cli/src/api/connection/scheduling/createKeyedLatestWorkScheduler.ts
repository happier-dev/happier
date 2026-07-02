import type { KeyedBackoffTracker } from './createKeyedBackoffTracker';

export type KeyedLatestWorkCounters = {
  accepted: number;
  coalesced: number;
  suppressed: number;
  started: number;
  succeeded: number;
  failed: number;
  deferred: number;
  retried: number;
};

export type KeyedLatestWorkStats = {
  retainedKeyCount: number;
  pendingKeyCount: number;
  activeCount: number;
};

export type KeyedLatestWorkEnqueueResult =
  | { type: 'accepted' }
  | { type: 'coalesced' }
  | { type: 'suppressed'; reason: string };

export type KeyedLatestWorkScheduler<TKey extends string, TPayload> = {
  enqueue: (key: TKey, payload: TPayload, opts?: Readonly<{ material?: boolean }>) => KeyedLatestWorkEnqueueResult;
  flushKey: (key: TKey, timeoutMs: number) => Promise<boolean>;
  flushAll: (timeoutMs: number) => Promise<void>;
  cancelKey: (key: TKey) => void;
  dispose: () => void;
  notifyConnectivityChanged: () => void;
  getCounters: () => KeyedLatestWorkCounters;
  getStats: () => KeyedLatestWorkStats;
};

export type KeyedLatestWorkEvent<TKey extends string> = Readonly<{
  type: keyof KeyedLatestWorkCounters;
  key: TKey;
  reason?: string;
}>;

type Entry<TPayload> = {
  pending: { payload: TPayload; enqueuedAtMs: number } | null;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  lastRunAtMs: number | null;
  lastTouchedAtMs: number;
};

function normalizeNonNegativeMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const retryAfterMs = (error as Readonly<{ retryAfterMs?: unknown }>).retryAfterMs;
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return undefined;
  return Math.trunc(retryAfterMs);
}

export function createKeyedLatestWorkScheduler<TKey extends string, TPayload>(
  options: Readonly<{
    run: (key: TKey, payload: TPayload) => Promise<void>;
    maxConcurrent: number;
    minKeyIntervalMs: number;
    maxKeys: number;
    maxKeyAgeMs: number;
    maxPendingPayloadAgeMs: number;
    now?: () => number;
    isConnected?: () => boolean;
    backoff?: KeyedBackoffTracker;
    shouldRetry?: (error: unknown) => boolean;
    onEvent?: (event: KeyedLatestWorkEvent<TKey>) => void;
  }>,
): KeyedLatestWorkScheduler<TKey, TPayload> {
  const entries = new Map<TKey, Entry<TPayload>>();
  const readyQueue: TKey[] = [];
  const maxConcurrent = normalizePositiveInteger(options.maxConcurrent);
  const minKeyIntervalMs = normalizeNonNegativeMs(options.minKeyIntervalMs);
  const maxKeys = normalizePositiveInteger(options.maxKeys);
  const maxKeyAgeMs = normalizeNonNegativeMs(options.maxKeyAgeMs);
  const maxPendingPayloadAgeMs = normalizeNonNegativeMs(options.maxPendingPayloadAgeMs);
  const now = options.now ?? Date.now;
  const isConnected = options.isConnected ?? (() => true);
  const shouldRetry = options.shouldRetry ?? (() => options.backoff !== undefined);
  const counters: KeyedLatestWorkCounters = {
    accepted: 0,
    coalesced: 0,
    suppressed: 0,
    started: 0,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    retried: 0,
  };
  let activeCount = 0;
  let disposed = false;

  function emit(type: keyof KeyedLatestWorkCounters, key: TKey, reason?: string): void {
    counters[type] += 1;
    options.onEvent?.({ type, key, ...(reason ? { reason } : {}) });
  }

  function clearEntryTimer(entry: Entry<TPayload>): void {
    if (!entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  function removeFromReadyQueue(key: TKey): void {
    const index = readyQueue.indexOf(key);
    if (index >= 0) readyQueue.splice(index, 1);
  }

  function maybeDeleteEntry(key: TKey, entry: Entry<TPayload>): void {
    if (entry.pending || entry.inFlight || entry.timer || entry.queued || entry.lastRunAtMs !== null) return;
    entries.delete(key);
  }

  function dropPending(key: TKey, entry: Entry<TPayload>, reason: string): void {
    if (!entry.pending) return;
    entry.pending = null;
    emit('suppressed', key, reason);
    maybeDeleteEntry(key, entry);
  }

  function pruneExpiredEntries(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.inFlight) continue;
      if (entry.pending && nowMs - entry.pending.enqueuedAtMs > maxPendingPayloadAgeMs) {
        clearEntryTimer(entry);
        entry.queued = false;
        removeFromReadyQueue(key);
        dropPending(key, entry, 'pending_payload_stale');
        continue;
      }
      if (!entry.pending && nowMs - entry.lastTouchedAtMs > maxKeyAgeMs) {
        clearEntryTimer(entry);
        entry.queued = false;
        removeFromReadyQueue(key);
        entries.delete(key);
      }
    }
  }

  function evictForMaxKeys(protectedKey?: TKey): boolean {
    while (entries.size > maxKeys) {
      let oldestKey: TKey | null = null;
      let oldestTouchedAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (protectedKey !== undefined && key === protectedKey) continue;
        if (entry.inFlight) continue;
        if (entry.lastTouchedAtMs < oldestTouchedAt) {
          oldestTouchedAt = entry.lastTouchedAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) return false;
      const entry = entries.get(oldestKey);
      if (!entry) return false;
      clearEntryTimer(entry);
      entry.queued = false;
      removeFromReadyQueue(oldestKey);
      if (entry.pending) emit('suppressed', oldestKey, 'max_keys');
      entries.delete(oldestKey);
    }
    return true;
  }

  function getOrCreateEntry(key: TKey, nowMs: number): Entry<TPayload> | null {
    const existing = entries.get(key);
    if (existing) {
      existing.lastTouchedAtMs = nowMs;
      return existing;
    }
    const created: Entry<TPayload> = {
      pending: null,
      inFlight: null,
      timer: null,
      queued: false,
      lastRunAtMs: null,
      lastTouchedAtMs: nowMs,
    };
    entries.set(key, created);
    if (!evictForMaxKeys(key)) {
      entries.delete(key);
      return null;
    }
    return created;
  }

  function queueReady(key: TKey, entry: Entry<TPayload>): void {
    if (entry.queued) return;
    entry.queued = true;
    readyQueue.push(key);
  }

  function scheduleTimer(key: TKey, entry: Entry<TPayload>, delayMs: number): void {
    clearEntryTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      scheduleKey(key, { force: true });
    }, delayMs);
    entry.timer.unref?.();
  }

  function readDelayUntilEligible(key: TKey, entry: Entry<TPayload>, force: boolean): number | null {
    if (!isConnected()) return null;
    if (force) return 0;
    const nowMs = now();
    const intervalAnchorMs = entry.lastRunAtMs ?? entry.pending?.enqueuedAtMs ?? nowMs;
    if (minKeyIntervalMs > 0) {
      const minIntervalDelay = Math.max(0, intervalAnchorMs + minKeyIntervalMs - nowMs);
      if (minIntervalDelay > 0) return minIntervalDelay;
    }
    const backoffDelay = options.backoff?.getDelayMs(key) ?? 0;
    if (backoffDelay > 0) return backoffDelay;
    return 0;
  }

  function scheduleKey(key: TKey, opts: Readonly<{ force: boolean }>): void {
    if (disposed) return;
    const entry = entries.get(key);
    if (!entry || entry.inFlight || !entry.pending) {
      if (entry) maybeDeleteEntry(key, entry);
      return;
    }
    const nowMs = now();
    entry.lastTouchedAtMs = nowMs;
    if (nowMs - entry.pending.enqueuedAtMs > maxPendingPayloadAgeMs) {
      clearEntryTimer(entry);
      dropPending(key, entry, 'pending_payload_stale');
      return;
    }
    const delayMs = readDelayUntilEligible(key, entry, opts.force);
    if (delayMs === null) {
      clearEntryTimer(entry);
      emit('deferred', key, 'offline');
      return;
    }
    if (delayMs > 0) {
      emit('deferred', key, options.backoff?.getDelayMs(key) ? 'backoff' : 'min_key_interval');
      scheduleTimer(key, entry, delayMs);
      return;
    }
    queueReady(key, entry);
    drainQueue();
  }

  function drainQueue(): void {
    if (disposed) return;
    while (activeCount < maxConcurrent && readyQueue.length > 0) {
      const key = readyQueue.shift();
      if (!key) continue;
      const entry = entries.get(key);
      if (!entry) continue;
      entry.queued = false;
      if (!entry.pending || entry.inFlight) {
        maybeDeleteEntry(key, entry);
        continue;
      }
      startRun(key, entry);
    }
  }

  function startRun(key: TKey, entry: Entry<TPayload>): void {
    const pending = entry.pending;
    if (!pending) return;
    entry.pending = null;
    activeCount += 1;
    emit('started', key);

    const inFlight = (async () => {
      try {
        await options.run(key, pending.payload);
        options.backoff?.recordSuccess(key);
        entry.lastRunAtMs = now();
        entry.lastTouchedAtMs = entry.lastRunAtMs;
        emit('succeeded', key);
      } catch (error) {
        emit('failed', key);
        if (!disposed && shouldRetry(error)) {
          options.backoff?.recordFailure(key, { retryAfterMs: readRetryAfterMs(error) });
          if (!entry.pending) {
            entry.pending = { payload: pending.payload, enqueuedAtMs: pending.enqueuedAtMs };
          }
          emit('retried', key);
        }
      }
    })().finally(() => {
      activeCount -= 1;
      if (entry.inFlight === inFlight) entry.inFlight = null;
      if (entry.pending) {
        scheduleKey(key, { force: false });
      } else {
        maybeDeleteEntry(key, entry);
      }
      drainQueue();
    });

    entry.inFlight = inFlight;
  }

  function waitForKeySettled(key: TKey, timeoutMs: number): Promise<boolean> {
    const timeout = normalizeNonNegativeMs(timeoutMs);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (pollTimer) clearTimeout(pollTimer);
        resolve(value);
      };
      const schedulePoll = () => {
        if (settled) return;
        pollTimer = setTimeout(poll, Math.min(25, Math.max(1, timeout)));
      };
      const poll = () => {
        pollTimer = null;
        const entry = entries.get(key);
        if (!entry || (!entry.pending && !entry.inFlight && !entry.timer && !entry.queued)) {
          finish(true);
          return;
        }
        if (entry.inFlight) {
          void entry.inFlight.finally(schedulePoll);
          return;
        }
        schedulePoll();
      };
      timer = setTimeout(() => finish(false), timeout);
      poll();
    });
  }

  return {
    enqueue: (key, payload, opts) => {
      if (disposed || !key) return { type: 'suppressed', reason: 'disposed' };
      const nowMs = now();
      pruneExpiredEntries(nowMs);
      const entry = getOrCreateEntry(key, nowMs);
      if (!entry) {
        emit('suppressed', key, 'max_keys');
        return { type: 'suppressed', reason: 'max_keys' };
      }
      const material = opts?.material !== false;
      if (!material && !entry.pending && !entry.inFlight && entry.lastRunAtMs !== null && nowMs - entry.lastRunAtMs < minKeyIntervalMs) {
        emit('suppressed', key, 'min_key_interval');
        maybeDeleteEntry(key, entry);
        return { type: 'suppressed', reason: 'min_key_interval' };
      }

      const resultType = entry.pending || entry.inFlight || entry.timer || entry.queued ? 'coalesced' : 'accepted';
      entry.pending = { payload, enqueuedAtMs: nowMs };
      entry.lastTouchedAtMs = nowMs;
      emit(resultType, key);
      scheduleKey(key, { force: false });
      return { type: resultType };
    },
    flushKey: async (key, timeoutMs) => {
      const entry = entries.get(key);
      if (!entry) return true;
      if (entry.pending) {
        clearEntryTimer(entry);
        scheduleKey(key, { force: true });
      }
      return await waitForKeySettled(key, timeoutMs);
    },
    flushAll: async (timeoutMs) => {
      for (const [key, entry] of entries) {
        if (entry.pending) {
          clearEntryTimer(entry);
          scheduleKey(key, { force: true });
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, normalizeNonNegativeMs(timeoutMs));
        Promise.all([...entries.keys()].map((key) => waitForKeySettled(key, timeoutMs))).then(() => {
          clearTimeout(timer);
          resolve();
        }, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    cancelKey: (key) => {
      const entry = entries.get(key);
      if (!entry) return;
      clearEntryTimer(entry);
      entry.pending = null;
      entry.queued = false;
      removeFromReadyQueue(key);
      maybeDeleteEntry(key, entry);
    },
    dispose: () => {
      disposed = true;
      for (const [key, entry] of entries) {
        clearEntryTimer(entry);
        entry.pending = null;
        entry.queued = false;
        removeFromReadyQueue(key);
      }
      readyQueue.length = 0;
      entries.clear();
    },
    notifyConnectivityChanged: () => {
      if (disposed || !isConnected()) return;
      for (const key of entries.keys()) {
        scheduleKey(key, { force: false });
      }
    },
    getCounters: () => ({ ...counters }),
    getStats: () => {
      let pendingKeyCount = 0;
      for (const entry of entries.values()) {
        if (entry.pending) pendingKeyCount += 1;
      }
      return { retainedKeyCount: entries.size, pendingKeyCount, activeCount };
    },
  };
}
