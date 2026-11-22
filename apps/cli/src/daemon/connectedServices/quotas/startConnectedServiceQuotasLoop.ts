import type { RequesterConnectedAccountObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { startSingleFlightIntervalLoop, type SingleFlightLoopSchedule } from '@/daemon/lifecycle/singleFlightIntervalLoop';

export type ConnectedServiceQuotasLoopHandle = Readonly<{
  stop: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  wake: () => void;
  subscribeAfterTick: (listener: (signal?: AbortSignal) => void | Promise<void>) => () => void;
}>;

export function startConnectedServiceQuotasLoop(params: Readonly<{
  enabled: boolean;
  tickMs: number;
  coordinator: Readonly<{ tickOnce: (signal?: AbortSignal) => Promise<void | SingleFlightLoopSchedule> }>;
  subscribeWake?: (listener: (event?: RequesterConnectedAccountObservation) => void) => () => void;
  runImmediately?: boolean;
  onTickError: (error: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}>): ConnectedServiceQuotasLoopHandle | null {
  if (!params.enabled) return null;

  let stopped = false;
  const settledTickListeners = new Set<(signal?: AbortSignal) => void | Promise<void>>();
  const loop = startSingleFlightIntervalLoop({
    intervalMs: params.tickMs,
    task: async signal => {
      const schedule = await params.coordinator.tickOnce(signal);
      signal.throwIfAborted();
      if (!stopped) await Promise.all([...settledTickListeners].map(listener => listener(signal)));
      return schedule;
    },
    onError: params.onTickError,
    unref: true,
    respectFailureDeadlineForTriggers: true,
    setTimeoutFn: params.setTimeoutFn,
    clearTimeoutFn: params.clearTimeoutFn,
  });
  // A durable request identifies a person's Refresh even on a mixed change page.
  const unsubscribeWake = params.subscribeWake?.(event => {
    loop.trigger(event?.quotaRefreshRecordIds?.length ? { bypassFailureDeadline: true } : undefined);
  });
  if (params.runImmediately) loop.trigger();

  return {
    stop: async () => {
      stopped = true;
      unsubscribeWake?.();
      settledTickListeners.clear();
      await loop.stop();
    },
    pause: loop.pause,
    resume: () => { loop.trigger(); loop.resume(); },
    wake: loop.trigger,
    subscribeAfterTick: listener => {
      if (!stopped) settledTickListeners.add(listener);
      return () => { settledTickListeners.delete(listener); };
    },
  };
}
