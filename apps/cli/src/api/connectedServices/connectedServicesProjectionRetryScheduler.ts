type ProjectionWork = (signal: AbortSignal) => Promise<void>;

export type ConnectedServicesProjectionRetryScheduler = Readonly<{
  schedule(work: ProjectionWork, options?: Readonly<{ runImmediately?: boolean }>): void;
  cancel(): void;
  close(): void;
  waitForIdle(): Promise<void>;
  hasPendingWork(): boolean;
}>;

export function createConnectedServicesProjectionRetryScheduler(options: Readonly<{
  baseDelayMs?: number;
  maxDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}> = {}): ConnectedServicesProjectionRetryScheduler {
  const baseDelayMs = Math.max(1, Math.trunc(options.baseDelayMs ?? 1_000));
  const maxDelayMs = Math.max(baseDelayMs, Math.trunc(options.maxDelayMs ?? 30_000));
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let immediateRunQueued = false;
  let inFlight: Readonly<{
    epoch: number;
    controller: AbortController;
    promise: Promise<void>;
  }> | null = null;
  let attempt = 0;
  let epoch = 0;
  let latestWork: ProjectionWork | null = null;
  let latestWorkRunsImmediately = false;
  let closed = false;
  const idleWaiters = new Set<() => void>();

  const hasPendingWork = (): boolean => (
    timer !== null || immediateRunQueued || inFlight !== null || latestWork !== null
  );

  const resolveIdleWaiters = (): void => {
    if (hasPendingWork()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const runLatest = (): void => {
    immediateRunQueued = false;
    if (inFlight || !latestWork) {
      resolveIdleWaiters();
      return;
    }

    const work = latestWork;
    latestWork = null;
    latestWorkRunsImmediately = false;
    const capturedEpoch = epoch;
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => await work(controller.signal));
    const currentRun = { epoch: capturedEpoch, controller, promise } as const;
    inFlight = currentRun;

    void promise.then(() => {
      if (capturedEpoch === epoch) attempt = 0;
    }).catch(() => {
      if (capturedEpoch !== epoch || controller.signal.aborted) return;
      attempt += 1;
      if (!latestWork) latestWork = work;
      latestWorkRunsImmediately = false;
    }).finally(() => {
      if (inFlight === currentRun) inFlight = null;
      arm();
      resolveIdleWaiters();
    });
  };

  const arm = (): void => {
    if (closed || timer || immediateRunQueued || inFlight || !latestWork) return;
    if (latestWorkRunsImmediately && attempt === 0) {
      immediateRunQueued = true;
      queueMicrotask(runLatest);
      return;
    }
    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(attempt, 20)));
    const capturedEpoch = epoch;
    timer = setTimer(() => {
      timer = null;
      if (capturedEpoch !== epoch) {
        resolveIdleWaiters();
        return;
      }
      runLatest();
    }, delayMs);
    timer.unref?.();
  };

  return Object.freeze({
    schedule(work, scheduleOptions): void {
      if (closed) return;
      latestWork = work;
      latestWorkRunsImmediately ||= scheduleOptions?.runImmediately === true;
      arm();
    },
    cancel(): void {
      epoch += 1;
      if (timer) clearTimer(timer);
      timer = null;
      immediateRunQueued = false;
      latestWork = null;
      latestWorkRunsImmediately = false;
      attempt = 0;
      inFlight?.controller.abort();
      resolveIdleWaiters();
    },
    close(): void {
      closed = true;
      epoch += 1;
      if (timer) clearTimer(timer);
      timer = null;
      immediateRunQueued = false;
      latestWork = null;
      latestWorkRunsImmediately = false;
      attempt = 0;
      inFlight?.controller.abort();
      resolveIdleWaiters();
    },
    waitForIdle(): Promise<void> {
      if (!hasPendingWork()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    hasPendingWork,
  });
}
