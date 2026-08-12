export const PROVIDER_PROBE_REFRESH_TRIGGERS = [
  'enable',
  'detail_open',
  'picker_open',
  'manual_refresh',
] as const;

export type ProviderProbeRefreshTrigger = typeof PROVIDER_PROBE_REFRESH_TRIGGERS[number];
export type ProviderCatalogRefreshTrigger = ProviderProbeRefreshTrigger;
export type ProviderHealthRefreshTrigger = ProviderProbeRefreshTrigger;

export const PROVIDER_HEALTH_REFRESH_TTL_MS = 30_000;

type ScheduledResult = Readonly<{
  status: string;
  error?: Readonly<{ retryAfterMs?: number }>;
}>;
type Completed<T extends ScheduledResult> = Readonly<{
  result: T;
  expiresAt: number;
  failures: number;
}>;

function jitteredBackoff(failures: number, random: () => number): number {
  const base = Math.min(24 * 60 * 60_000, 30_000 * (2 ** Math.max(0, failures - 1)));
  const factor = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.round(base * factor);
}

function createLane<T extends ScheduledResult>(input: Readonly<{
  now: () => number;
  random: () => number;
  successTtlMs: number;
  maxCompletedEntries: number;
  execute(operation: () => Promise<T>): Promise<T>;
}>) {
  const inFlight = new Map<string, Promise<T>>();
  const causalInFlight = new Map<string, Promise<T>>();
  const completed = new Map<string, Completed<T>>();

  const executeAndCache = (
    key: string,
    operation: () => Promise<T>,
    resolveCompletedKey: (result: T) => string = () => key,
  ) => input.execute(operation).then((result) => {
      const completedKey = resolveCompletedKey(result);
      const previousFailures = completed.get(completedKey)?.failures ?? 0;
      const failures = result.status === 'success' ? 0 : previousFailures + 1;
      completed.delete(key);
      completed.delete(completedKey);
      const currentTime = input.now();
      for (const [completedKey, entry] of completed) {
        if (currentTime >= entry.expiresAt) completed.delete(completedKey);
      }
      while (completed.size >= input.maxCompletedEntries) {
        const oldestKey = completed.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        completed.delete(oldestKey);
      }
      const retryAfterMs = result.status === 'error'
        && Number.isFinite(result.error?.retryAfterMs)
        && (result.error?.retryAfterMs ?? 0) > 0
        ? result.error!.retryAfterMs!
        : 0;
      completed.set(completedKey, {
        result,
        failures,
        expiresAt: currentTime + (result.status === 'success'
          ? input.successTtlMs
          : Math.max(jitteredBackoff(failures, input.random), retryAfterMs)),
      });
      return result;
    });

  const run = async (
    key: string,
    manual: boolean,
    operation: () => Promise<T>,
    resolveCompletedKey?: (result: T) => string,
  ): Promise<T> => {
    const active = inFlight.get(key);
    if (active) return active;
    const cached = completed.get(key);
    if (!manual && cached && input.now() < cached.expiresAt) return cached.result;
    let promise!: Promise<T>;
    promise = executeAndCache(key, operation, resolveCompletedKey).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };

  const runAfter = (
    key: string,
    frontier: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const frontierKey = JSON.stringify([key, frontier]);
    const sameFrontier = causalInFlight.get(frontierKey);
    if (sameFrontier) return sameFrontier;
    const predecessor = inFlight.get(key);
    let promise!: Promise<T>;
    promise = (async () => {
      if (predecessor) await predecessor.catch(() => undefined);
      return executeAndCache(key, operation);
    })().finally(() => {
      if (causalInFlight.get(frontierKey) === promise) causalInFlight.delete(frontierKey);
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    causalInFlight.set(frontierKey, promise);
    inFlight.set(key, promise);
    return promise;
  };

  return { run, runAfter };
}

export function createProviderProbeScheduler(input: Readonly<{
  now?: () => number;
  random?: () => number;
  catalogSuccessTtlMs?: number;
  healthSuccessTtlMs?: number;
  maxCompletedEntriesPerLane?: number;
  maxConcurrentOperations?: number;
}> = {}) {
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  const maxCompletedEntries = input.maxCompletedEntriesPerLane ?? 2_048;
  if (!Number.isInteger(maxCompletedEntries) || maxCompletedEntries < 1 || maxCompletedEntries > 8_192) {
    throw new TypeError('Provider probe scheduler completed-entry limit must be an integer between 1 and 8192');
  }
  const maxConcurrentOperations = input.maxConcurrentOperations ?? 4;
  if (!Number.isInteger(maxConcurrentOperations) || maxConcurrentOperations < 1 || maxConcurrentOperations > 32) {
    throw new TypeError('Provider probe scheduler concurrency must be an integer between 1 and 32');
  }
  let activeOperations = 0;
  const waiters: Array<() => void> = [];
  const execute = async <T extends ScheduledResult>(operation: () => Promise<T>): Promise<T> => {
    if (activeOperations >= maxConcurrentOperations) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    activeOperations += 1;
    try {
      return await operation();
    } finally {
      activeOperations -= 1;
      waiters.shift()?.();
    }
  };
  const catalog = createLane({ now, random, successTtlMs: input.catalogSuccessTtlMs ?? 5 * 60_000, maxCompletedEntries, execute });
  const health = createLane({
    now,
    random,
    successTtlMs: input.healthSuccessTtlMs ?? PROVIDER_HEALTH_REFRESH_TTL_MS,
    maxCompletedEntries,
    execute,
  });
  return {
    runCatalog<T extends ScheduledResult>(
      key: string,
      trigger: ProviderCatalogRefreshTrigger,
      operation: () => Promise<T>,
    ): Promise<T> {
      return catalog.run(key, trigger === 'manual_refresh' || trigger === 'enable', operation) as Promise<T>;
    },
    runCatalogWithEffectiveKey<T extends ScheduledResult>(
      key: string,
      trigger: ProviderCatalogRefreshTrigger,
      operation: () => Promise<T>,
      resolveCompletedKey: (result: T) => string,
    ): Promise<T> {
      return catalog.run(
        key,
        trigger === 'manual_refresh' || trigger === 'enable',
        operation,
        resolveCompletedKey,
      ) as Promise<T>;
    },
    runCatalogAfter<T extends ScheduledResult>(
      key: string,
      frontier: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      return catalog.runAfter(key, frontier, operation) as Promise<T>;
    },
    runHealth<T extends ScheduledResult>(
      key: string,
      trigger: ProviderHealthRefreshTrigger,
      operation: () => Promise<T>,
    ): Promise<T> {
      return health.run(key, trigger === 'manual_refresh' || trigger === 'enable', operation) as Promise<T>;
    },
  };
}
