export function resolveAutomationPollingConfig(env: NodeJS.ProcessEnv): {
  leaseDurationMs: number;
  heartbeatMs: number;
} {
  const readInt = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  const leaseDurationMs = readInt(env.HAPPIER_AUTOMATION_LEASE_MS, 30_000);
  const heartbeatMs = readInt(
    env.HAPPIER_AUTOMATION_HEARTBEAT_MS,
    Math.ceil(leaseDurationMs / 2),
  );
  return {
    leaseDurationMs,
    heartbeatMs: Math.min(heartbeatMs, Math.ceil(leaseDurationMs / 2)),
  };
}
