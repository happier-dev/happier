export type KeyedBackoffState = {
  attempt: number;
  delayMs: number;
  retryAtMs: number;
};

export type KeyedBackoffTracker = {
  recordFailure: (key: string, opts?: Readonly<{ retryAfterMs?: number; retryAfterAtMs?: number }>) => KeyedBackoffState;
  recordSuccess: (key: string) => void;
  reset: (key: string) => void;
  getState: (key: string) => KeyedBackoffState | null;
  getDelayMs: (key: string) => number;
};

function normalizePositiveMs(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function normalizeRatio(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function createKeyedBackoffTracker(options: Readonly<{
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
}>): KeyedBackoffTracker {
  const states = new Map<string, KeyedBackoffState>();
  const baseDelayMs = normalizePositiveMs(options.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, normalizePositiveMs(options.maxDelayMs));
  const jitterRatio = normalizeRatio(options.jitterRatio);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  function computeDelayMs(attempt: number): number {
    const exponentialDelay = baseDelayMs * (2 ** Math.max(0, attempt - 1));
    const cappedDelay = Math.min(maxDelayMs, exponentialDelay);
    if (jitterRatio <= 0) return Math.trunc(cappedDelay);
    const jitterOffset = cappedDelay * (((random() * 2) - 1) * jitterRatio);
    return Math.max(1, Math.trunc(cappedDelay + jitterOffset));
  }

  return {
    recordFailure: (key, opts) => {
      const current = states.get(key);
      const attempt = (current?.attempt ?? 0) + 1;
      const nowMs = now();
      const retryAfterAtMs = typeof opts?.retryAfterAtMs === 'number' && Number.isFinite(opts.retryAfterAtMs)
        ? opts.retryAfterAtMs
        : null;
      const retryAfterMs = typeof opts?.retryAfterMs === 'number' && Number.isFinite(opts.retryAfterMs)
        ? Math.max(0, Math.trunc(opts.retryAfterMs))
        : null;
      const retryAtMs = Math.max(
        nowMs + computeDelayMs(attempt),
        retryAfterAtMs ?? Number.NEGATIVE_INFINITY,
        retryAfterMs === null ? Number.NEGATIVE_INFINITY : nowMs + retryAfterMs,
      );
      const state = {
        attempt,
        retryAtMs,
        delayMs: Math.max(0, Math.trunc(retryAtMs - nowMs)),
      };
      states.set(key, state);
      return state;
    },
    recordSuccess: (key) => {
      states.delete(key);
    },
    reset: (key) => {
      states.delete(key);
    },
    getState: (key) => states.get(key) ?? null,
    getDelayMs: (key) => {
      const state = states.get(key);
      if (!state) return 0;
      return Math.max(0, Math.trunc(state.retryAtMs - now()));
    },
  };
}
