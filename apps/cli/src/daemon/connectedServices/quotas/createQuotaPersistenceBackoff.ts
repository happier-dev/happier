import { createKeyedBackoffTracker, type KeyedBackoffTracker } from '@/api/connection/scheduling';

/** Shared cadence for retryable Home quota and account-usage writes. */
export function createQuotaPersistenceBackoff(options: Readonly<{
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  now: () => number;
  random?: () => number;
}>): KeyedBackoffTracker {
  return createKeyedBackoffTracker({
    baseDelayMs:
      typeof options.baseDelayMs === 'number' && Number.isFinite(options.baseDelayMs)
        ? Math.max(1, Math.trunc(options.baseDelayMs))
        : 1_000,
    maxDelayMs:
      typeof options.maxDelayMs === 'number' && Number.isFinite(options.maxDelayMs)
        ? Math.max(1, Math.trunc(options.maxDelayMs))
        : 60_000,
    jitterRatio:
      typeof options.jitterRatio === 'number' && Number.isFinite(options.jitterRatio)
        ? Math.min(1, Math.max(0, options.jitterRatio))
        : 0.2,
    now: options.now,
    random: options.random,
  });
}
