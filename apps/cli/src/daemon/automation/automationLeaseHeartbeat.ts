export function startAutomationLeaseHeartbeat(params: {
  heartbeatMs: number;
  onHeartbeat: () => Promise<void>;
  onError: (error: unknown) => void;
}): { stop: () => void } {
  let active = true;
  const timer = setInterval(() => {
    if (!active) return;
    void params.onHeartbeat().catch((error) => {
      // A failed lease heartbeat means this invocation no longer has proven
      // currentness. Stop issuing stale heartbeats before notifying the Run
      // executor, which aborts later effects at its own owner boundary.
      active = false;
      clearInterval(timer);
      params.onError(error);
    });
  }, Math.max(1_000, params.heartbeatMs));

  return {
    stop: () => {
      active = false;
      clearInterval(timer);
    },
  };
}
