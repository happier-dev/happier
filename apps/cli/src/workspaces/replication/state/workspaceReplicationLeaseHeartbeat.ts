export function startWorkspaceReplicationLeaseHeartbeat<TInput>(input: Readonly<{
  ttlMs: number;
  buildRenewInput: () => TInput;
  renewLease: (input: TInput) => Promise<unknown>;
}>): Readonly<{
  stop: () => Promise<void>;
}> {
  const intervalMs = Math.max(1000, Math.floor(input.ttlMs / 3));
  let stopped = false;
  let inFlight: Promise<unknown> | null = null;

  const handle = setInterval(() => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = input.renewLease(input.buildRenewInput())
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  handle.unref?.();

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(handle);
    const pending = inFlight;
    if (pending) {
      await pending.catch(() => undefined);
    }
  };

  return { stop };
}
