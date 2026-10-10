export type ConnectedServiceQuotasLoopHandle = Readonly<{
  stop: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  subscribeAfterTick: (listener: () => void | Promise<void>) => () => void;
}>;

export function startConnectedServiceQuotasLoop(params: Readonly<{
  enabled: boolean;
  tickMs: number;
  coordinator: Readonly<{ tickOnce: () => Promise<void> }>;
  onTickError: (error: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}>): ConnectedServiceQuotasLoopHandle | null {
  if (!params.enabled) return null;

  const tickMs = Math.max(1, Math.trunc(params.tickMs));
  const setIntervalImpl = params.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl =
    params.clearIntervalFn ?? ((handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>));

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let paused = false;
  let stopPromise: Promise<void> | null = null;
  const settledTickListeners = new Set<() => void | Promise<void>>();
  const intervalHandle = setIntervalImpl(() => {
    if (stopped || inFlight) return;
    if (paused) return;
    inFlight = (async () => {
      try {
        await params.coordinator.tickOnce();
        if (!stopped) await Promise.all([...settledTickListeners].map(listener => listener()));
      } catch (error) {
        params.onTickError(error);
      } finally {
        inFlight = null;
      }
    })();
  }, tickMs);
  (intervalHandle as unknown as { unref?: () => void })?.unref?.();

  return {
    stop: async () => {
      if (stopPromise) {
        await stopPromise;
        return;
      }
      stopped = true;
      settledTickListeners.clear();
      clearIntervalImpl(intervalHandle);
      stopPromise = (async () => {
        await inFlight;
      })();
      await stopPromise;
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    subscribeAfterTick: listener => {
      if (!stopped) settledTickListeners.add(listener);
      return () => { settledTickListeners.delete(listener); };
    },
  };
}
