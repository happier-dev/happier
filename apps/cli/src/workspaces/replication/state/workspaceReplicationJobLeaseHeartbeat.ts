import { renewWorkspaceReplicationJobLease } from './workspaceReplicationJobLease';

export function startWorkspaceReplicationJobLeaseHeartbeat(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  ttlMs: number;
  nowMs: () => number;
}>): Readonly<{
  stop: () => Promise<void>;
  hasLeaseBeenLost: () => boolean;
  whenLeaseLost: Promise<void>;
  probeOnce: () => Promise<void>;
}> {
  const intervalMs = Math.max(1000, Math.floor(input.ttlMs / 3));
  let stopped = false;
  let leaseLost = false;
  let inFlight: Promise<unknown> | null = null;
  let handle: ReturnType<typeof setInterval> | null = null;
  let resolveLeaseLost: (() => void) | null = null;
  const whenLeaseLost = new Promise<void>((resolve) => {
    resolveLeaseLost = resolve;
  });

  const markLeaseLost = (): void => {
    if (leaseLost) return;
    leaseLost = true;
    resolveLeaseLost?.();
    resolveLeaseLost = null;
    if (handle) {
      clearInterval(handle);
    }
  };

  const probeOnce = async (): Promise<void> => {
    if (stopped || leaseLost) return;
    if (inFlight) {
      await inFlight.catch(() => undefined);
      return;
    }
    inFlight = renewWorkspaceReplicationJobLease({
      activeServerDir: input.activeServerDir,
      jobId: input.jobId,
      ownerId: input.ownerId,
      nowMs: input.nowMs(),
      ttlMs: input.ttlMs,
    }).then((result) => {
      if (!result.renewed) {
        markLeaseLost();
      }
    }).catch(() => undefined).finally(() => {
      inFlight = null;
    });
    await inFlight.catch(() => undefined);
  };

  handle = setInterval(() => {
    if (stopped) return;
    if (leaseLost) return;
    if (inFlight) return;
    void probeOnce();
  }, intervalMs);
  handle.unref?.();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (handle) {
      clearInterval(handle);
    }
    const pending = inFlight;
    if (pending) {
      await pending.catch(() => undefined);
    }
  };

  return {
    stop,
    hasLeaseBeenLost: () => leaseLost,
    whenLeaseLost,
    probeOnce,
  };
}
