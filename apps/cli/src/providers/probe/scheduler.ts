export const PROVIDER_PROBE_REFRESH_TRIGGERS = [
  'enable',
  'detail_open',
  'picker_open',
  'manual_refresh',
] as const;

export type ProviderProbeRefreshTrigger = typeof PROVIDER_PROBE_REFRESH_TRIGGERS[number];
export type ProviderCatalogRefreshTrigger = ProviderProbeRefreshTrigger;
export type ProviderHealthRefreshTrigger = ProviderProbeRefreshTrigger;

export const PROVIDER_CATALOG_REFRESH_TTL_MS = 5 * 60_000;
export const PROVIDER_HEALTH_REFRESH_TTL_MS = 30_000;
export const PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS = 4;

export type ProviderProbeScheduledResult = Readonly<{
  status: string;
  error?: Readonly<{ retryAfterMs?: number; [key: string]: unknown }>;
  completedKey?: string;
}>;
type Completed<T extends ProviderProbeScheduledResult> = Readonly<{
  result: T;
  expiresAt: number;
  failures: number;
}>;

/** One caller's interest in shared probe work. Refusal remains at the
 * Provider result boundary rather than becoming an untyped scheduler error. */
export type ProviderProbeSchedulerWaiterOptions<T extends ProviderProbeScheduledResult> = Readonly<{
  unavailable(): T;
  /**
   * Refusal for local admission capacity, where no endpoint request was ever
   * attempted. Owners that would otherwise report an endpoint outage supply it
   * so a host-side queue limit is never reported as a provider failure.
   * Defaults to `unavailable` for owners with no separate capacity result.
   */
  localCapacityUnavailable?(): T;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}>;

function jitteredBackoff(failures: number, random: () => number): number {
  const base = Math.min(24 * 60 * 60_000, 30_000 * (2 ** Math.max(0, failures - 1)));
  const factor = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.round(base * factor);
}

type AdmissionWork = {
  pending: boolean;
  queued: boolean;
  start(): void;
};

function createAdmissionController(input: Readonly<{
  maxConcurrentOperations: number;
  maxPendingOperations: number;
}>) {
  let activeOperations = 0;
  let pendingOperations = 0;
  let draining = false;
  const queue: AdmissionWork[] = [];

  const removeQueued = (work: AdmissionWork): void => {
    if (!work.queued) return;
    const index = queue.indexOf(work);
    if (index >= 0) queue.splice(index, 1);
    work.queued = false;
  };

  const start = (work: AdmissionWork): void => {
    if (work.pending) {
      work.pending = false;
      pendingOperations -= 1;
    }
    work.queued = false;
    activeOperations += 1;
    work.start();
  };

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (activeOperations < input.maxConcurrentOperations) {
        const work = queue.shift();
        if (!work) return;
        work.queued = false;
        if (!work.pending) continue;
        start(work);
      }
    } finally {
      draining = false;
    }
  };

  return {
    hasActiveCapacity: () => activeOperations < input.maxConcurrentOperations,
    hasPendingCapacity: () => pendingOperations < input.maxPendingOperations,
    admit(work: AdmissionWork, waitForPredecessor: boolean): boolean {
      if (!waitForPredecessor && activeOperations < input.maxConcurrentOperations) {
        start(work);
        return true;
      }
      if (pendingOperations >= input.maxPendingOperations) return false;
      pendingOperations += 1;
      work.pending = true;
      if (!waitForPredecessor) {
        work.queued = true;
        queue.push(work);
      }
      return true;
    },
    ready(work: AdmissionWork): void {
      if (!work.pending) return;
      if (activeOperations < input.maxConcurrentOperations) {
        start(work);
        return;
      }
      work.queued = true;
      queue.push(work);
    },
    cancel(work: AdmissionWork): void {
      if (!work.pending) return;
      removeQueued(work);
      work.pending = false;
      pendingOperations -= 1;
    },
    release(): void {
      activeOperations -= 1;
      if (activeOperations < 0) throw new Error('Provider probe scheduler active count underflow');
      drain();
    },
  };
}

type ProbeWaiter<T extends ProviderProbeScheduledResult> = {
  options: ProviderProbeSchedulerWaiterOptions<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
  abortListener?: () => void;
};

type LaneWork<T extends ProviderProbeScheduledResult> = AdmissionWork & {
  key: string;
  /** The admitted work owns its operation; waiters own only their interest. */
  operation: () => Promise<T>;
  causalKey?: string;
  predecessor?: LaneWork<T>;
  started: boolean;
  terminal: boolean;
  waiters: Set<ProbeWaiter<T>>;
  terminalPromise: Promise<void>;
  resolveTerminal(): void;
};

function createLane<T extends ProviderProbeScheduledResult>(input: Readonly<{
  now: () => number;
  random: () => number;
  maxCompletedEntries: number;
  admission: ReturnType<typeof createAdmissionController>;
}>) {
  const inFlight = new Map<string, LaneWork<T>>();
  const causalInFlight = new Map<string, LaneWork<T>>();
  const completed = new Map<string, Completed<T>>();

  /**
   * Retains only the small failure facts the backoff needs. Catalog freshness
   * is owned by the persisted runtime state, which every demand caller already
   * consults before scheduling, so a successful payload has no second owner
   * here and is released as soon as its callers settle.
   */
  const cache = (key: string, result: T): T => {
    const completedKey = result.completedKey ?? key;
    const previousFailures = completed.get(completedKey)?.failures ?? 0;
    const failures = result.status === 'success' ? 0 : previousFailures + 1;
    completed.delete(key);
    completed.delete(completedKey);
    if (result.status === 'success') return result;
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
      expiresAt: currentTime + Math.max(jitteredBackoff(failures, input.random), retryAfterMs),
    });
    return result;
  };

  const callerIsLive = (options: ProviderProbeSchedulerWaiterOptions<T>): boolean => {
    if (options.signal?.aborted) return false;
    if (!options.isCurrent) return true;
    try {
      return options.isCurrent();
    } catch {
      return false;
    }
  };

  const refuse = (
    options: ProviderProbeSchedulerWaiterOptions<T>,
    reason: 'unavailable' | 'localCapacity',
  ): T => (reason === 'localCapacity' && options.localCapacityUnavailable
    ? options.localCapacityUnavailable()
    : options.unavailable());

  const settleUnavailable = (
    waiter: ProbeWaiter<T>,
    reason: 'unavailable' | 'localCapacity' = 'unavailable',
  ): void => {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.abortListener && waiter.options.signal) {
      waiter.options.signal.removeEventListener('abort', waiter.abortListener);
      waiter.abortListener = undefined;
    }
    try {
      waiter.resolve(refuse(waiter.options, reason));
    } catch (error) {
      waiter.reject(error);
    }
  };

  const settleResult = (waiter: ProbeWaiter<T>, result: T): void => {
    if (waiter.settled) return;
    if (!callerIsLive(waiter.options)) {
      settleUnavailable(waiter);
      return;
    }
    waiter.settled = true;
    if (waiter.abortListener && waiter.options.signal) {
      waiter.options.signal.removeEventListener('abort', waiter.abortListener);
      waiter.abortListener = undefined;
    }
    waiter.resolve(result);
  };

  const settleError = (waiter: ProbeWaiter<T>, error: unknown): void => {
    if (waiter.settled) return;
    if (!callerIsLive(waiter.options)) {
      settleUnavailable(waiter);
      return;
    }
    waiter.settled = true;
    if (waiter.abortListener && waiter.options.signal) {
      waiter.options.signal.removeEventListener('abort', waiter.abortListener);
      waiter.abortListener = undefined;
    }
    waiter.reject(error);
  };

  const removeWork = (work: LaneWork<T>): void => {
    if (inFlight.get(work.key) === work) {
      if (work.predecessor && !work.predecessor.terminal) {
        inFlight.set(work.key, work.predecessor);
      } else {
        inFlight.delete(work.key);
      }
    }
    if (work.causalKey && causalInFlight.get(work.causalKey) === work) {
      causalInFlight.delete(work.causalKey);
    }
  };

  const redirectCausalSuccessors = (work: LaneWork<T>): void => {
    for (const successor of causalInFlight.values()) {
      if (successor !== work && successor.predecessor === work) {
        successor.predecessor = work.predecessor;
      }
    }
  };

  const finishWork = (
    work: LaneWork<T>,
    outcome: Readonly<{ kind: 'success'; result: T }>
      | Readonly<{ kind: 'error'; error: unknown }>
      | Readonly<{ kind: 'unavailable' }>
      | Readonly<{ kind: 'localCapacity' }>,
  ): void => {
    if (work.terminal) return;
    work.terminal = true;
    if (!work.started) {
      input.admission.cancel(work);
      redirectCausalSuccessors(work);
    }
    removeWork(work);
    for (const waiter of work.waiters) {
      if (outcome.kind === 'success') settleResult(waiter, outcome.result);
      else if (outcome.kind === 'error') settleError(waiter, outcome.error);
      else settleUnavailable(waiter, outcome.kind);
    }
    work.waiters.clear();
    if (work.started) input.admission.release();
    work.resolveTerminal();
  };

  const removeWaiter = (work: LaneWork<T>, waiter: ProbeWaiter<T>): void => {
    if (waiter.settled) return;
    settleUnavailable(waiter);
    work.waiters.delete(waiter);
    if (!work.started && work.waiters.size === 0) {
      finishWork(work, { kind: 'unavailable' });
    }
  };

  const attachWaiter = (
    work: LaneWork<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T> => {
    if (!callerIsLive(options)) {
      try {
        return Promise.resolve(options.unavailable());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    let resolve!: (result: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const waiter: ProbeWaiter<T> = {
      options,
      resolve,
      reject,
      settled: false,
    };
    work.waiters.add(waiter);
    if (options.signal) {
      const onAbort = () => removeWaiter(work, waiter);
      waiter.abortListener = onAbort;
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
    return promise;
  };

  const hasLiveWaiter = (work: LaneWork<T>): boolean => {
    for (const waiter of [...work.waiters]) {
      if (callerIsLive(waiter.options)) return true;
      removeWaiter(work, waiter);
    }
    return false;
  };

  const startWork = (work: LaneWork<T>): void => {
    if (work.terminal) return;
    work.started = true;
    if (!hasLiveWaiter(work)) {
      finishWork(work, { kind: 'unavailable' });
      return;
    }
    let operation: Promise<T>;
    try {
      operation = work.operation();
    } catch (error) {
      finishWork(work, { kind: 'error', error });
      return;
    }
    void operation.then(
      (result) => {
        try {
          finishWork(work, {
            kind: 'success',
            result: cache(work.key, result),
          });
        } catch (error) {
          finishWork(work, { kind: 'error', error });
        }
      },
      (error: unknown) => finishWork(work, { kind: 'error', error }),
    );
  };

  const createWork = (
    key: string,
    operation: () => Promise<T>,
    causalKey?: string,
    predecessor?: LaneWork<T>,
  ): LaneWork<T> => {
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    const work: LaneWork<T> = {
      key,
      operation,
      ...(causalKey ? { causalKey } : {}),
      ...(predecessor ? { predecessor } : {}),
      pending: false,
      queued: false,
      started: false,
      terminal: false,
      waiters: new Set(),
      terminalPromise,
      resolveTerminal,
      start: () => startWork(work),
    };
    return work;
  };

  const waitForPredecessor = (
    work: LaneWork<T>,
    predecessor: LaneWork<T>,
  ): void => {
    void predecessor.terminalPromise.then(() => {
      if (work.terminal) return;
      if (work.predecessor !== predecessor) {
        if (work.predecessor) {
          waitForPredecessor(work, work.predecessor);
        } else {
          input.admission.ready(work);
        }
        return;
      }
      input.admission.ready(work);
    });
  };

  const run = async (
    key: string,
    manual: boolean,
    operation: () => Promise<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T> => {
    const active = inFlight.get(key);
    if (active) return attachWaiter(active, options);
    if (!callerIsLive(options)) {
      try {
        return options.unavailable();
      } catch (error) {
        throw error;
      }
    }
    const cached = completed.get(key);
    if (!manual && cached && input.now() < cached.expiresAt) return cached.result;
    const requiresPending = !input.admission.hasActiveCapacity();
    if (requiresPending && !input.admission.hasPendingCapacity()) {
      return refuse(options, 'localCapacity');
    }
    const work = createWork(key, operation);
    inFlight.set(key, work);
    const promise = attachWaiter(work, options);
    if (!work.terminal && work.waiters.size === 0) {
      finishWork(work, { kind: 'unavailable' });
      return promise;
    }
    if (!work.terminal && !input.admission.admit(work, false)) {
      finishWork(work, { kind: 'localCapacity' });
    }
    return promise;
  };

  const runAfter = async (
    key: string,
    frontier: string,
    operation: () => Promise<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T> => {
    const frontierKey = JSON.stringify([key, frontier]);
    const sameFrontier = causalInFlight.get(frontierKey);
    if (sameFrontier) return attachWaiter(sameFrontier, options);
    if (!callerIsLive(options)) {
      try {
        return options.unavailable();
      } catch (error) {
        throw error;
      }
    }
    const predecessor = inFlight.get(key);
    const requiresPending = predecessor !== undefined || !input.admission.hasActiveCapacity();
    if (requiresPending && !input.admission.hasPendingCapacity()) {
      return refuse(options, 'localCapacity');
    }
    const work = createWork(key, operation, frontierKey, predecessor);
    causalInFlight.set(frontierKey, work);
    inFlight.set(key, work);
    const promise = attachWaiter(work, options);
    if (work.terminal) return promise;
    if (work.waiters.size === 0) {
      finishWork(work, { kind: 'unavailable' });
      return promise;
    }
    if (!input.admission.admit(work, predecessor !== undefined)) {
      finishWork(work, { kind: 'localCapacity' });
      return promise;
    }
    if (predecessor) {
      waitForPredecessor(work, predecessor);
    }
    return promise;
  };

  return { run, runAfter };
}

export function createProviderProbeScheduler(input: Readonly<{
  now?: () => number;
  random?: () => number;
  maxCompletedEntriesPerLane?: number;
  maxConcurrentOperations?: number;
  maxPendingOperations?: number;
}> = {}) {
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  const maxCompletedEntries = input.maxCompletedEntriesPerLane ?? 2_048;
  if (!Number.isInteger(maxCompletedEntries) || maxCompletedEntries < 1 || maxCompletedEntries > 8_192) {
    throw new TypeError('Provider probe scheduler completed-entry limit must be an integer between 1 and 8192');
  }
  const maxConcurrentOperations = input.maxConcurrentOperations
    ?? PROVIDER_PROBE_DEFAULT_MAX_CONCURRENT_OPERATIONS;
  if (!Number.isInteger(maxConcurrentOperations) || maxConcurrentOperations < 1 || maxConcurrentOperations > 32) {
    throw new TypeError('Provider probe scheduler concurrency must be an integer between 1 and 32');
  }
  const maxPendingOperations = input.maxPendingOperations ?? 64;
  if (!Number.isInteger(maxPendingOperations) || maxPendingOperations < 1 || maxPendingOperations > 256) {
    throw new TypeError('Provider probe scheduler pending limit must be an integer between 1 and 256');
  }
  const admission = createAdmissionController({ maxConcurrentOperations, maxPendingOperations });
  const catalog = createLane<ProviderProbeScheduledResult>({
    now,
    random,
    maxCompletedEntries,
    admission,
  });
  const health = createLane<ProviderProbeScheduledResult>({
    now,
    random,
    maxCompletedEntries,
    admission,
  });

  function runCatalog<T extends ProviderProbeScheduledResult>(
    key: string,
    trigger: ProviderCatalogRefreshTrigger,
    operation: () => Promise<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T>;
  function runCatalog(
    key: string,
    trigger: ProviderCatalogRefreshTrigger,
    operation: () => Promise<ProviderProbeScheduledResult>,
    options: ProviderProbeSchedulerWaiterOptions<ProviderProbeScheduledResult>,
  ): Promise<ProviderProbeScheduledResult> {
    const forced = trigger === 'manual_refresh' || trigger === 'enable';
    return catalog.run(key, forced, operation, options);
  }

  function runCatalogAfter<T extends ProviderProbeScheduledResult>(
    key: string,
    frontier: string,
    operation: () => Promise<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T>;
  function runCatalogAfter(
    key: string,
    frontier: string,
    operation: () => Promise<ProviderProbeScheduledResult>,
    options: ProviderProbeSchedulerWaiterOptions<ProviderProbeScheduledResult>,
  ): Promise<ProviderProbeScheduledResult> {
    return catalog.runAfter(key, frontier, operation, options);
  }

  function runHealth<T extends ProviderProbeScheduledResult>(
    key: string,
    trigger: ProviderHealthRefreshTrigger,
    operation: () => Promise<T>,
    options: ProviderProbeSchedulerWaiterOptions<T>,
  ): Promise<T>;
  function runHealth(
    key: string,
    trigger: ProviderHealthRefreshTrigger,
    operation: () => Promise<ProviderProbeScheduledResult>,
    options: ProviderProbeSchedulerWaiterOptions<ProviderProbeScheduledResult>,
  ): Promise<ProviderProbeScheduledResult> {
    return health.run(
      key,
      trigger === 'manual_refresh' || trigger === 'enable',
      operation,
      options,
    );
  }

  return {
    runCatalog,
    runCatalogAfter,
    runHealth,
  };
}
