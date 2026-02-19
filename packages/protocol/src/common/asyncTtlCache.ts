export type AsyncTtlCacheEntry<T> =
  | Readonly<{ kind: 'success'; updatedAt: number; expiresAt: number; value: T }>
  | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export class AsyncTtlCache<T> {
  readonly #cache = new Map<string, AsyncTtlCacheEntry<T>>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #defaultSuccessTtlMs: number;
  readonly #defaultErrorTtlMs: number;

  constructor(params: Readonly<{ successTtlMs: number; errorTtlMs: number }>) {
    this.#defaultSuccessTtlMs = Math.max(0, params.successTtlMs);
    this.#defaultErrorTtlMs = Math.max(0, params.errorTtlMs);
  }

  get(key: string): AsyncTtlCacheEntry<T> | null {
    return this.#cache.get(key) ?? null;
  }

  keys(): IterableIterator<string> {
    return this.#cache.keys();
  }

  delete(key: string): void {
    this.#cache.delete(key);
    this.#inflight.delete(key);
  }

  clear(): void {
    this.#cache.clear();
    this.#inflight.clear();
  }

  isFresh(entry: AsyncTtlCacheEntry<T>, nowMs = Date.now()): boolean {
    return nowMs >= 0 && nowMs < entry.expiresAt;
  }

  setSuccess(key: string, value: T, params?: Readonly<{ nowMs?: number; ttlMs?: number }>): void {
    const nowMs = typeof params?.nowMs === 'number' ? params.nowMs : Date.now();
    const ttlMs = typeof params?.ttlMs === 'number' ? Math.max(0, params.ttlMs) : this.#defaultSuccessTtlMs;
    this.#cache.set(key, { kind: 'success', updatedAt: nowMs, expiresAt: nowMs + ttlMs, value });
  }

  setError(key: string, params?: Readonly<{ nowMs?: number; ttlMs?: number }>): void {
    const nowMs = typeof params?.nowMs === 'number' ? params.nowMs : Date.now();
    const ttlMs = typeof params?.ttlMs === 'number' ? Math.max(0, params.ttlMs) : this.#defaultErrorTtlMs;
    this.#cache.set(key, { kind: 'error', updatedAt: nowMs, expiresAt: nowMs + ttlMs });
  }

  async runDedupe<R>(key: string, run: () => Promise<R>): Promise<R> {
    const existing = this.#inflight.get(key) as Promise<R> | undefined;
    if (existing) return await existing;

    const pending = (async () => {
      try {
        return await run();
      } finally {
        this.#inflight.delete(key);
      }
    })();

    this.#inflight.set(key, pending);
    return await pending;
  }
}
