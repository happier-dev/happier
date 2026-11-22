export type SingleFlightIntervalLoopHandle = Readonly<{
  stop: () => Promise<void>;
  trigger: () => void;
  pause: () => void;
  resume: () => void;
}>;

export type SingleFlightLoopSchedule = Readonly<{ nextAutomaticRunAfterMs: number | null }>;

export function startSingleFlightIntervalLoop(args: Readonly<{
  intervalMs: number;
  task: (signal: AbortSignal) => void | SingleFlightLoopSchedule | Promise<void | SingleFlightLoopSchedule>;
  onError?: (error: unknown) => void;
  unref?: boolean;
  failureBackoffMs?: number;
  maxFailureBackoffMs?: number;
  respectFailureDeadlineForTriggers?: boolean;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}>): SingleFlightIntervalLoopHandle {
  let stopped = false;
  let inFlight = false;
  let paused = false;
  let pendingForcedRerun = false;
  let failureCount = 0;
  let nextAutomaticRunAtMs: number | null = Date.now() + Math.max(1, Math.floor(args.intervalMs));
  let timer: unknown = null;
  let activeRun: Promise<void> | null = null;
  const abortController = new AbortController();
  const intervalMs = Math.max(1, Math.floor(args.intervalMs));
  const failureBackoffMs = Math.max(0, Math.floor(args.failureBackoffMs ?? 0));
  const maxFailureBackoffMs = Math.max(
    failureBackoffMs,
    Math.floor(args.maxFailureBackoffMs ?? failureBackoffMs),
  );
  const setTimeoutImpl = args.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutImpl = args.clearTimeoutFn ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const clearTimer = () => {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  };
  const armTimer = () => {
    clearTimer();
    if (stopped || paused || inFlight || nextAutomaticRunAtMs === null) return;
    // Node timers have a signed 32-bit delay; preserve longer owner deadlines by rearming.
    const remainingMs = Math.max(0, nextAutomaticRunAtMs - Date.now());
    timer = setTimeoutImpl(() => {
      timer = null;
      if (remainingMs > 2_147_483_647) armTimer();
      else runOnce();
    }, Math.min(2_147_483_647, remainingMs));
    if (args.unref) (timer as { unref?: () => void } | null)?.unref?.();
  };

  const runOnce = (options: Readonly<{ force?: boolean }> = {}) => {
    if (stopped) return;
    if (paused) { if (options.force) pendingForcedRerun = true; return; }
    if (inFlight) {
      // An explicit trigger while a run is in flight coalesces into exactly
      // one forced rerun once that run settles; stop/pause prevents it.
      if (options.force) pendingForcedRerun = true;
      return;
    }
    if (options.force && args.respectFailureDeadlineForTriggers && failureCount > 0
      && nextAutomaticRunAtMs !== null && Date.now() < nextAutomaticRunAtMs) {
      pendingForcedRerun = true;
      if (timer === null) armTimer();
      return;
    }
    clearTimer();
    pendingForcedRerun = false;
    inFlight = true;
    let result: ReturnType<typeof args.task>;
    try { result = args.task(abortController.signal); }
    catch (error) { result = Promise.reject(error); }
    activeRun = Promise.resolve(result)
      .then((result) => {
        failureCount = 0;
        nextAutomaticRunAtMs = result?.nextAutomaticRunAfterMs === null ? null
          : Date.now() + (typeof result?.nextAutomaticRunAfterMs === 'number'
            && Number.isFinite(result.nextAutomaticRunAfterMs)
            && result.nextAutomaticRunAfterMs > 0
            ? Math.max(1, Math.floor(result.nextAutomaticRunAfterMs)) : intervalMs);
      })
      .catch((error) => {
        if (failureBackoffMs > 0) {
          const multiplier = Math.max(1, 2 ** failureCount);
          const delayMs = Math.min(maxFailureBackoffMs, failureBackoffMs * multiplier);
          nextAutomaticRunAtMs = Date.now() + delayMs;
        } else nextAutomaticRunAtMs = Date.now() + intervalMs;
        failureCount += 1;
        args.onError?.(error);
      })
      .finally(() => {
        inFlight = false;
        activeRun = null;
        if (pendingForcedRerun && !paused) {
          runOnce({ force: true });
        } else armTimer();
      });
  };

  armTimer();

  return {
    stop: async () => {
      if (!stopped) {
        stopped = true;
        clearTimer();
        abortController.abort();
      }
      await activeRun;
    },
    trigger: () => {
      runOnce({ force: true });
    },
    pause: () => {
      paused = true;
      clearTimer();
    },
    resume: () => {
      paused = false;
      if (pendingForcedRerun) runOnce({ force: true });
      else armTimer();
    },
  };
}
