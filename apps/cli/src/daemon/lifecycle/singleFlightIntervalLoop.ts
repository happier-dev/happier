export type SingleFlightIntervalLoopHandle = Readonly<{
  stop: () => void;
  trigger: () => void;
}>;

export function startSingleFlightIntervalLoop(args: Readonly<{
  intervalMs: number;
  task: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}>): SingleFlightIntervalLoopHandle {
  let stopped = false;
  let inFlight = false;
  const intervalMs = Math.max(1, Math.floor(args.intervalMs));

  const runOnce = () => {
    if (stopped) return;
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

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    trigger: () => {
      runOnce();
    },
  };
}

