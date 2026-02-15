export function startAutomationLeaseHeartbeat(params: {
  heartbeatMs: number;
  onHeartbeat: () => Promise<void>;
  onError: (error: unknown) => void;
}): { stop: () => void } {
  let active = true;
  const timer = setInterval(() => {
    if (!active) return;
    void params.onHeartbeat().catch((error) => {
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
