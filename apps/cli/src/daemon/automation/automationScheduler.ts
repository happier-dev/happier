export function resolveAutomationPollingConfig(env: NodeJS.ProcessEnv): {
  leaseDurationMs: number;
  heartbeatMs: number;
} {
  const readInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const leaseDurationMs = readInt(env.HAPPIER_AUTOMATION_LEASE_MS, 30_000, 5_000, 15 * 60_000);
  const heartbeatMs = readInt(
    env.HAPPIER_AUTOMATION_HEARTBEAT_MS,
    Math.floor(leaseDurationMs / 2),
    1_000,
    60_000,
  );
  return {
    leaseDurationMs,
    heartbeatMs: Math.min(heartbeatMs, Math.floor(leaseDurationMs / 2)),
  };
}
