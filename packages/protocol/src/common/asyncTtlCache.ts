export type AsyncTtlCacheEntry<T> =
  | Readonly<{ kind: 'success'; updatedAt: number; expiresAt: number; value: T }>
  | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export type AsyncTtlCacheRunContext = Readonly<{
  /** Cancel the transport only when no live observer still needs this operation. */
  signal: AbortSignal;
  /** External work may ignore abort; retired work must not publish into its replacement. */
  isCurrent: () => boolean;
}>;

type InflightRun = {
  promise: Promise<unknown>;
  controller: AbortController;
  observers: number;
  settled: boolean;
};

export class AsyncTtlCache<T> {
  readonly #cache = new Map<string, AsyncTtlCacheEntry<T>>();
  readonly #inflight = new Map<string, InflightRun>();
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
    const pending = this.#inflight.get(key);
    if (pending) this.#retire(key, pending);
  }

  clear(): void {
    this.#cache.clear();
    for (const [key, pending] of this.#inflight) this.#retire(key, pending);
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

  #retire(key: string, pending: InflightRun): void {
    if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
    pending.controller.abort();
  }

  async runDedupe<R>(
    key: string,
    run: (context: AsyncTtlCacheRunContext) => Promise<R>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<R> {
    if (options?.signal?.aborted) throw options.signal.reason;
    const existing = this.#inflight.get(key);
    if (existing) return await this.#observe<R>(key, existing, options?.signal);

    let resolve!: (value: R) => void;
    let reject!: (reason: unknown) => void;
    const pending: InflightRun = {
      promise: new Promise<R>((onResolve, onReject) => { resolve = onResolve; reject = onReject; }),
      controller: new AbortController(),
      observers: 0,
      settled: false,
    };
    this.#inflight.set(key, pending);
    const observation = this.#observe<R>(key, pending, options?.signal);
    const settle = () => {
      pending.settled = true;
      if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
    };
    try {
      void run({
        signal: pending.controller.signal,
        isCurrent: () => this.#inflight.get(key) === pending && !pending.controller.signal.aborted,
      }).then((value) => { settle(); resolve(value); }, (error: unknown) => { settle(); reject(error); });
    } catch (error) {
      settle();
      reject(error);
    }
    return await observation;
  }

  #observe<R>(key: string, pending: InflightRun, signal?: AbortSignal): Promise<R> {
    pending.observers += 1;
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        pending.observers -= 1;
        if (!pending.settled && pending.observers === 0) this.#retire(key, pending);
        return true;
      };
      const onAbort = () => {
        if (release()) reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void (pending.promise as Promise<R>).then(
        (value) => { if (release()) resolve(value); },
        (error: unknown) => { if (release()) reject(error); },
      );
    });
  }
}
