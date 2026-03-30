export type SingleFlightIntervalLoopHandle = Readonly<{
  stop: () => void;
  trigger: () => void;
  pause: () => void;
  resume: () => void;
}>;

export function startSingleFlightIntervalLoop(args: Readonly<{
  intervalMs: number;
  task: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  unref?: boolean;
}>): SingleFlightIntervalLoopHandle {
  let stopped = false;
  let inFlight = false;
  let paused = false;
  const intervalMs = Math.max(1, Math.floor(args.intervalMs));

  const runOnce = () => {
    if (stopped) return;
    if (paused) return;
    if (inFlight) return;

    inFlight = true;
    Promise.resolve()
      .then(() => args.task())
      .catch((error) => {
        args.onError?.(error);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(runOnce, intervalMs);
  if (args.unref === true) {
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    trigger: () => {
      runOnce();
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
}
