import { renewWorkspaceReplicationJobLease } from './workspaceReplicationJobLease';

export function startWorkspaceReplicationJobLeaseHeartbeat(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  ownerId: string;
  ttlMs: number;
  nowMs: () => number;
}>): Readonly<{
  stop: () => Promise<void>;
}> {
  const intervalMs = Math.max(1000, Math.floor(input.ttlMs / 3));
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  const handle = setInterval(() => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = renewWorkspaceReplicationJobLease({
      activeServerDir: input.activeServerDir,
      jobId: input.jobId,
      ownerId: input.ownerId,
      nowMs: input.nowMs(),
      ttlMs: input.ttlMs,
    }).catch(() => undefined).finally(() => {
      inFlight = null;
    });
  }, intervalMs);
  handle.unref?.();

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    const pending = inFlight;
    if (pending) {
      await pending.catch(() => undefined);
    }
  };

  return { stop };
}
