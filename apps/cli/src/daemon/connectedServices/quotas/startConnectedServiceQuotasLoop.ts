export type ConnectedServiceQuotasLoopHandle = Readonly<{
  stop: () => void;
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
  let inFlight = false;
  const intervalHandle = setIntervalImpl(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        await params.coordinator.tickOnce();
      } catch (error) {
        params.onTickError(error);
      } finally {
        inFlight = false;
      }
    })();
  }, tickMs);
  (intervalHandle as unknown as { unref?: () => void })?.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(intervalHandle);
    },
  };
}
