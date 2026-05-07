export type LocalPendingQueueRemoteSwitchWatcher = Readonly<{
  stop: () => void;
}>;

export function startLocalPendingQueueRemoteSwitchWatcher(opts: Readonly<{
  peekPendingCount: () => Promise<number>;
  pollIntervalMs: number;
  requestRemoteSwitch: () => Promise<boolean>;
}>): LocalPendingQueueRemoteSwitchWatcher {
  let stopped = false;
  let triggered = false;
  let switchRequestInFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0
    ? Math.trunc(opts.pollIntervalMs)
    : 1;

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number): void => {
    if (stopped || triggered) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delayMs);
    timer.unref?.();
  };

  const poll = async (): Promise<void> => {
    if (stopped || triggered || switchRequestInFlight) return;

    try {
      const pendingCount = await opts.peekPendingCount();
      if (pendingCount > 0) {
        switchRequestInFlight = true;
        try {
          triggered = await opts.requestRemoteSwitch();
        } finally {
          switchRequestInFlight = false;
        }
        if (triggered) {
          return;
        }
        schedule(pollIntervalMs);
        return;
      }
    } catch {
      // Best-effort watcher: local mode should keep running if the server is
      // temporarily unreachable. The next interval will retry.
    }

    schedule(pollIntervalMs);
  };

  schedule(0);

  return {
    stop: () => {
      stopped = true;
      clearTimer();
    },
  };
}
