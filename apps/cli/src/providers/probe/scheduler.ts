import {
  awaitWithinProviderOperation,
  ProviderOperationAbandonedError,
  type ProviderOperationLifetime,
} from '../operationLifetime';

export const PROVIDER_PROBE_REFRESH_TRIGGERS = [
  'enable', 'detail_open', 'picker_open', 'manual_refresh',
] as const;
export type ProviderProbeRefreshTrigger = typeof PROVIDER_PROBE_REFRESH_TRIGGERS[number];
export type ProviderCatalogRefreshTrigger = ProviderProbeRefreshTrigger;
export type ProviderHealthRefreshTrigger = ProviderProbeRefreshTrigger;

export type ProviderProbeScheduledResult = Readonly<{
  status: string;
  error?: Readonly<{ retryAfterMs?: number; [key: string]: unknown }>;
  completedKey?: string;
}>;
export type ProviderProbeSchedulerWaiterOptions<T extends ProviderProbeScheduledResult> = Readonly<{
  unavailable(): T;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}>;

type Waiter<T extends ProviderProbeScheduledResult> = {
  resolve(value: T): void;
  reject(error: unknown): void;
  options: ProviderProbeSchedulerWaiterOptions<T>;
  detach(): void;
};
type Work<T extends ProviderProbeScheduledResult> = {
  controller: AbortController;
  waiters: Set<Waiter<T>>;
  terminal: Promise<void>;
};

function isLive<T extends ProviderProbeScheduledResult>(options: ProviderProbeSchedulerWaiterOptions<T>): boolean {
  if (options.signal?.aborted) return false;
  try { return options.isCurrent?.() ?? true; }
  catch { return false; }
}

function createLane(now: () => number) {
  const inFlight = new Map<string, Work<ProviderProbeScheduledResult>>();
  // These deadlines come only from the endpoint's Retry-After response. No
  // local failure counter, delay, freshness period, or retry timer exists.
  const retryAfter = new Map<string, Readonly<{ until: number; result: ProviderProbeScheduledResult }>>();

  const run = <T extends ProviderProbeScheduledResult>(
    key: string,
    forced: boolean,
    operation: (signal: AbortSignal) => Promise<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T> => {
    if (!isLive(options)) return Promise.resolve().then(options.unavailable);
    const currentTime = now();
    for (const [identity, entry] of retryAfter) {
      if (entry.until <= currentTime) retryAfter.delete(identity);
    }
    const delayed = retryAfter.get(key);
    if (!forced && delayed) return Promise.resolve(delayed.result as T);
    let work = inFlight.get(key);
    if (work?.controller.signal.aborted) return runFresh(key, operation, options);
    let start: (() => void) | undefined;
    if (!work) {
      const controller = new AbortController();
      let finish!: () => void;
      const terminal = new Promise<void>(resolve => { finish = resolve; });
      work = { controller, waiters: new Set(), terminal };
      const admitted = work;
      inFlight.set(key, admitted);
      start = () => {
        let pending: Promise<T>;
        try { pending = operation(controller.signal); }
        catch (error) { pending = Promise.reject(error); }
        void pending.then(result => {
          if (inFlight.get(key) === admitted) inFlight.delete(key);
          const delay = result.status === 'error' ? result.error?.retryAfterMs : undefined;
          if (!controller.signal.aborted) {
            retryAfter.delete(key);
            retryAfter.delete(result.completedKey ?? key);
            if (delay !== undefined && Number.isFinite(delay) && delay > 0) {
              retryAfter.set(result.completedKey ?? key, { until: now() + delay, result });
            }
          }
          for (const waiter of admitted.waiters) {
            waiter.detach();
            try { waiter.resolve(isLive(waiter.options) ? result : waiter.options.unavailable()); }
            catch (error) { waiter.reject(error); }
          }
        }, error => {
          if (inFlight.get(key) === admitted) inFlight.delete(key);
          for (const waiter of admitted.waiters) {
            waiter.detach();
            if (isLive(waiter.options)) waiter.reject(error);
            else {
              try { waiter.resolve(waiter.options.unavailable()); }
              catch (refusal) { waiter.reject(refusal); }
            }
          }
        }).finally(() => {
          admitted.waiters.clear();
          if (inFlight.get(key) === admitted) inFlight.delete(key);
          finish();
        });
      };
    }
    const shared = work;
    const result = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        waiter.detach();
        shared.waiters.delete(waiter);
        try { resolve(options.unavailable()); }
        catch (error) { reject(error); }
        if (shared.waiters.size === 0) shared.controller.abort();
      };
      const waiter: Waiter<ProviderProbeScheduledResult> = {
        resolve: value => resolve(value as T), reject, options,
        detach: () => options.signal?.removeEventListener('abort', onAbort),
      };
      shared.waiters.add(waiter);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    start?.();
    return result;
  };

  const runFresh = async <T extends ProviderProbeScheduledResult>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T> => {
    // Explicit Load needs its own observation after the effect. Wait out an
    // older read so it cannot publish over that observation, then dispatch a
    // new read. The Load owner already coalesces identical Load operations.
    while (inFlight.has(key)) {
      if (!isLive(options)) return options.unavailable();
      try {
        await awaitWithinProviderOperation(inFlight.get(key)!.terminal, {
          wallDeadlineAtMs: Infinity,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (error instanceof ProviderOperationAbandonedError) return options.unavailable();
        throw error;
      }
    }
    return run(key, true, operation, options);
  };
  return { run, runFresh };
}

export function createProviderProbeScheduler(input: Readonly<{ now?: () => number }> = {}) {
  const now = input.now ?? Date.now;
  const catalog = createLane(now);
  const health = createLane(now);
  return {
    async runDns<T>(operation: () => Promise<T>, lifetime: ProviderOperationLifetime, isCurrent?: () => boolean): Promise<T> {
      await awaitWithinProviderOperation(Promise.resolve(), lifetime, now);
      if (isCurrent && !isCurrent()) throw new ProviderOperationAbandonedError('cancelled');
      return await awaitWithinProviderOperation(operation(), lifetime, now);
    },
    runCatalog<T extends ProviderProbeScheduledResult>(key: string, trigger: ProviderCatalogRefreshTrigger,
      operation: (signal: AbortSignal) => Promise<T>, options: ProviderProbeSchedulerWaiterOptions<T>): Promise<T> {
      return catalog.run(key, trigger === 'manual_refresh' || trigger === 'enable', operation, options);
    },
    runCatalogFresh: catalog.runFresh,
    runHealth<T extends ProviderProbeScheduledResult>(key: string, trigger: ProviderHealthRefreshTrigger,
      operation: (signal: AbortSignal) => Promise<T>, options: ProviderProbeSchedulerWaiterOptions<T>): Promise<T> {
      return health.run(key, trigger === 'manual_refresh' || trigger === 'enable', operation, options);
    },
  };
}
