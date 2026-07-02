import type {
  KeyedBackoffTracker,
  KeyedLatestWorkCounters,
  KeyedLatestWorkEnqueueResult,
  KeyedLatestWorkScheduler,
  KeyedLatestWorkStats,
} from '../../../api/connection/scheduling';
import { createKeyedLatestWorkScheduler } from '../../../api/connection/scheduling';

export type ConnectedServiceQuotaPersistencePayload = Readonly<{
  materialFingerprint: string;
}>;

export type ConnectedServiceQuotaPersistenceScheduler<TKey extends string, TPayload extends ConnectedServiceQuotaPersistencePayload> =
  KeyedLatestWorkScheduler<TKey, TPayload>;

type PausedQuotaPersistencePayload<TPayload extends ConnectedServiceQuotaPersistencePayload> = {
  consecutiveFailures: number;
  lastTouchedAtMs: number;
  materialFingerprint: string;
  payload: TPayload;
};

class QuotaPersistenceRetryControlError extends Error {
  public constructor(
    public readonly retry: boolean,
    public readonly originalError: unknown,
  ) {
    super('quota_persistence_retry_control');
    this.name = 'QuotaPersistenceRetryControlError';
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

export function createConnectedServiceQuotaPersistenceScheduler<
  TKey extends string,
  TPayload extends ConnectedServiceQuotaPersistencePayload,
>(options: Readonly<{
  run: (key: TKey, payload: TPayload) => Promise<void>;
  maxConcurrent: number;
  minKeyIntervalMs: number;
  maxKeys: number;
  maxKeyAgeMs: number;
  maxPendingPayloadAgeMs: number;
  maxConsecutiveFailures?: number;
  now?: () => number;
  isConnected?: () => boolean;
  backoff?: KeyedBackoffTracker;
  shouldRetry?: (error: unknown) => boolean;
  shouldPauseAfterFailure?: (error: unknown) => boolean;
  onEvent?: (event: Readonly<{ type: keyof KeyedLatestWorkCounters; key: TKey; reason?: string }>) => void;
}>): ConnectedServiceQuotaPersistenceScheduler<TKey, TPayload> {
  const maxConsecutiveFailures = normalizePositiveInteger(options.maxConsecutiveFailures, 5);
  const maxPausedKeys = normalizePositiveInteger(options.maxKeys, 1);
  const now = options.now ?? Date.now;
  const pausedByKey = new Map<TKey, PausedQuotaPersistencePayload<TPayload>>();
  const forceFlushKeys = new Set<TKey>();
  let pausedSuppressedCount = 0;

  function shouldRetry(error: unknown): boolean {
    if (error instanceof QuotaPersistenceRetryControlError) return error.retry;
    return options.shouldRetry?.(error) ?? true;
  }

  function emitSuppressed(key: TKey, reason: string): void {
    pausedSuppressedCount += 1;
    options.onEvent?.({ type: 'suppressed', key, reason });
  }

  function evictOldestPausedKeys(protectedKey: TKey): void {
    while (pausedByKey.size > maxPausedKeys) {
      let oldestKey: TKey | null = null;
      let oldestTouchedAtMs = Number.POSITIVE_INFINITY;
      for (const [key, paused] of pausedByKey) {
        if (key === protectedKey) continue;
        if (paused.lastTouchedAtMs < oldestTouchedAtMs) {
          oldestTouchedAtMs = paused.lastTouchedAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      pausedByKey.delete(oldestKey);
      forceFlushKeys.delete(oldestKey);
    }
  }

  function rememberPausedPayload(key: TKey, payload: TPayload, consecutiveFailures: number): void {
    pausedByKey.set(key, {
      consecutiveFailures,
      lastTouchedAtMs: now(),
      materialFingerprint: payload.materialFingerprint,
      payload,
    });
    evictOldestPausedKeys(key);
  }

  const scheduler = createKeyedLatestWorkScheduler<TKey, TPayload>({
    ...options,
    run: async (key, payload) => {
      const forced = forceFlushKeys.delete(key);
      try {
        await options.run(key, payload);
        pausedByKey.delete(key);
      } catch (error) {
        if (!shouldRetry(error)) {
          pausedByKey.delete(key);
          throw new QuotaPersistenceRetryControlError(false, error);
        }

        if (options.shouldPauseAfterFailure?.(error) === false) {
          pausedByKey.delete(key);
          throw error;
        }

        const previous = pausedByKey.get(key);
        const previousFailures =
          !forced && previous?.materialFingerprint === payload.materialFingerprint
            ? previous.consecutiveFailures
            : 0;
        const consecutiveFailures = forced ? maxConsecutiveFailures : previousFailures + 1;

        if (consecutiveFailures >= maxConsecutiveFailures) {
          rememberPausedPayload(key, payload, maxConsecutiveFailures);
          throw new QuotaPersistenceRetryControlError(false, error);
        }

        rememberPausedPayload(key, payload, consecutiveFailures);
        throw error;
      }
    },
    shouldRetry,
  });

  function enqueuePausedPayloadForFlush(key: TKey, paused: PausedQuotaPersistencePayload<TPayload>): void {
    forceFlushKeys.add(key);
    scheduler.enqueue(key, paused.payload);
  }

  return {
    enqueue: (key, payload, opts): KeyedLatestWorkEnqueueResult => {
      const paused = pausedByKey.get(key);
      if (paused && paused.materialFingerprint === payload.materialFingerprint) {
        paused.payload = payload;
        paused.lastTouchedAtMs = now();
        emitSuppressed(key, 'paused_after_failures');
        return { type: 'suppressed', reason: 'paused_after_failures' };
      }
      if (paused && paused.materialFingerprint !== payload.materialFingerprint) {
        pausedByKey.delete(key);
        forceFlushKeys.delete(key);
      }
      return scheduler.enqueue(key, payload, opts);
    },
    flushKey: async (key, timeoutMs) => {
      const paused = pausedByKey.get(key);
      if (paused) enqueuePausedPayloadForFlush(key, paused);
      return await scheduler.flushKey(key, timeoutMs);
    },
    flushAll: async (timeoutMs) => {
      for (const [key, paused] of pausedByKey) {
        enqueuePausedPayloadForFlush(key, paused);
      }
      await scheduler.flushAll(timeoutMs);
    },
    cancelKey: (key) => {
      pausedByKey.delete(key);
      forceFlushKeys.delete(key);
      scheduler.cancelKey(key);
    },
    dispose: () => {
      pausedByKey.clear();
      forceFlushKeys.clear();
      scheduler.dispose();
    },
    notifyConnectivityChanged: () => scheduler.notifyConnectivityChanged(),
    getCounters: (): KeyedLatestWorkCounters => {
      const counters = scheduler.getCounters();
      return { ...counters, suppressed: counters.suppressed + pausedSuppressedCount };
    },
    getStats: (): KeyedLatestWorkStats => {
      const stats = scheduler.getStats();
      return { ...stats, retainedKeyCount: stats.retainedKeyCount + pausedByKey.size };
    },
  };
}
