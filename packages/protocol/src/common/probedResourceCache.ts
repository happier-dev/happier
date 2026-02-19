export type ProbedResourcePhase = 'idle' | 'loading' | 'refreshing';

export type ProbedResourceSnapshot<T> = Readonly<{
  phase: ProbedResourcePhase;
  data: T | null;
  dataUpdatedAt: number | null;
  error: unknown | null;
  errorUpdatedAt: number | null;
  isStale: boolean;
}>;

type ProbedResourceEntry<T> = {
  data: T | null;
  dataUpdatedAt: number | null;
  error: unknown | null;
  errorUpdatedAt: number | null;
  inflight: Promise<T | null> | null;
};

export class ProbedResourceCache<T> {
  readonly #entries = new Map<string, ProbedResourceEntry<T>>();
  readonly #staleTimeMs: number;
  readonly #errorCooldownMs: number;
  readonly #nowMs: () => number;
  readonly #listenersByKey = new Map<string, Set<() => void>>();

  constructor(params: Readonly<{ staleTimeMs: number; errorCooldownMs: number; nowMs?: () => number }>) {
    this.#staleTimeMs = Math.max(0, params.staleTimeMs);
    this.#errorCooldownMs = Math.max(0, params.errorCooldownMs);
    this.#nowMs = typeof params.nowMs === 'function' ? params.nowMs : () => Date.now();
  }

  keys(): IterableIterator<string> {
    return this.#entries.keys();
  }

  clear(): void {
    this.#entries.clear();
    this.#listenersByKey.clear();
  }

  delete(key: string): void {
    this.#entries.delete(key);
    this.#emit(key);
  }

  read(key: string): Readonly<{
    data: T | null;
    dataUpdatedAt: number | null;
    error: unknown | null;
    errorUpdatedAt: number | null;
    inflight: Promise<T | null> | null;
  }> | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    return {
      data: entry.data,
      dataUpdatedAt: entry.dataUpdatedAt,
      error: entry.error,
      errorUpdatedAt: entry.errorUpdatedAt,
      inflight: entry.inflight,
    };
  }

  getSnapshot(key: string, nowMs = this.#nowMs()): ProbedResourceSnapshot<T> {
    const entry = this.#entries.get(key) ?? null;
    const data = entry?.data ?? null;
    const dataUpdatedAt = entry?.dataUpdatedAt ?? null;
    const error = entry?.error ?? null;
    const errorUpdatedAt = entry?.errorUpdatedAt ?? null;
    const inflight = entry?.inflight ?? null;

    const isStale =
      dataUpdatedAt !== null &&
      nowMs >= 0 &&
      nowMs - dataUpdatedAt > this.#staleTimeMs;

    const phase: ProbedResourcePhase = inflight ? (data ? 'refreshing' : 'loading') : 'idle';

    return { phase, data, dataUpdatedAt, error, errorUpdatedAt, isStale };
  }

  setSuccess(key: string, data: T, nowMs = this.#nowMs()): void {
    const entry = this.#entries.get(key) ?? {
      data: null,
      dataUpdatedAt: null,
      error: null,
      errorUpdatedAt: null,
      inflight: null,
    };
    entry.data = data;
    entry.dataUpdatedAt = nowMs;
    entry.error = null;
    entry.errorUpdatedAt = null;
    this.#entries.set(key, entry);
    this.#emit(key);
  }

  setError(key: string, error: unknown, nowMs = this.#nowMs()): void {
    const entry = this.#entries.get(key) ?? {
      data: null,
      dataUpdatedAt: null,
      error: null,
      errorUpdatedAt: null,
      inflight: null,
    };
    entry.error = error;
    entry.errorUpdatedAt = nowMs;
    this.#entries.set(key, entry);
    this.#emit(key);
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.#listenersByKey.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listenersByKey.set(key, listeners);
    return () => {
      const current = this.#listenersByKey.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listenersByKey.delete(key);
    };
  }

  async ensure(
    key: string,
    fetcher: () => Promise<T>,
    opts?: Readonly<{ force?: boolean; nowMs?: number }>,
  ): Promise<T | null> {
    const nowMs = typeof opts?.nowMs === 'number' ? opts.nowMs : this.#nowMs();

    const existing = this.#entries.get(key) ?? {
      data: null,
      dataUpdatedAt: null,
      error: null,
      errorUpdatedAt: null,
      inflight: null,
    };

    if (existing.inflight) return await existing.inflight;

    const hasData = existing.dataUpdatedAt !== null;
    const isStale =
      hasData &&
      nowMs >= 0 &&
      nowMs - (existing.dataUpdatedAt as number) > this.#staleTimeMs;

    const inErrorCooldown =
      existing.errorUpdatedAt !== null &&
      nowMs >= 0 &&
      nowMs - existing.errorUpdatedAt < this.#errorCooldownMs;

    const shouldFetch = Boolean(
      opts?.force === true ||
        (!inErrorCooldown && (!hasData || isStale)),
    );

    if (!shouldFetch) {
      this.#entries.set(key, existing);
      return existing.data;
    }

    const pending = (async () => {
      try {
        const value = await fetcher();
        const commitNowMs = this.#nowMs();
        existing.data = value;
        existing.dataUpdatedAt = commitNowMs;
        existing.error = null;
        existing.errorUpdatedAt = null;
        return value;
      } catch (e) {
        const commitNowMs = this.#nowMs();
        existing.error = e;
        existing.errorUpdatedAt = commitNowMs;
        return existing.data;
      } finally {
        existing.inflight = null;
        this.#entries.set(key, existing);
        this.#emit(key);
      }
    })();

    existing.inflight = pending;
    this.#entries.set(key, existing);
    this.#emit(key);
    return await pending;
  }

  #emit(key: string): void {
    const listeners = this.#listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }
}
