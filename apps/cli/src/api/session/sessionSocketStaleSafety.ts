type TimeoutHandle = ReturnType<typeof setTimeout>;

export type SessionSocketStaleSafetyScheduler = Readonly<{
  start: () => void;
  stop: () => void;
  recordInboundUpdate: () => void;
}>;

export function resolveSessionSocketStaleSafetyDelayMs(params: {
  intervalMs: number;
  random?: () => number;
}): number {
  const intervalMs = Number.isFinite(params.intervalMs) && params.intervalMs > 0
    ? Math.trunc(params.intervalMs)
    : 0;
  if (intervalMs <= 0) return 0;

  const random = params.random ?? Math.random;
  const rawJitter = random();
  const jitterRatio = Number.isFinite(rawJitter) ? Math.max(0, Math.min(1, rawJitter)) : 0;
  const maxJitterMs = Math.min(30_000, Math.max(1, Math.trunc(intervalMs * 0.2)));
  return intervalMs + Math.trunc(maxJitterMs * jitterRatio);
}

export function createSessionSocketStaleSafetyScheduler(params: {
  intervalMs: number;
  random?: () => number;
  isOnline: () => boolean;
  runSafetyTick: () => Promise<void>;
}): SessionSocketStaleSafetyScheduler {
  let stopped = true;
  let timer: TimeoutHandle | null = null;
  let inFlight = false;

  const clear = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    clear();
    if (stopped) return;
    const delayMs = resolveSessionSocketStaleSafetyDelayMs({
      intervalMs: params.intervalMs,
      random: params.random,
    });
    if (delayMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      if (!params.isOnline()) {
        schedule();
        return;
      }
      if (inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      void params.runSafetyTick()
        .catch(() => {})
        .finally(() => {
          inFlight = false;
          schedule();
        });
    }, delayMs);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      clear();
    },
    recordInboundUpdate() {
      // Socket traffic does not prove all durable events arrived; keep the safety bound fixed.
    },
  };
}
