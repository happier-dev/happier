export function resolveAutomationPollingConfig(env: NodeJS.ProcessEnv): {
  claimPollMs: number;
  assignmentsRefreshMs: number;
  leaseDurationMs: number;
  heartbeatMs: number;
} {
  const readInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
    const parsed = Number.parseInt((value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const leaseDurationMs = readInt(env.HAPPIER_AUTOMATION_LEASE_MS, 30_000, 5_000, 15 * 60_000);
  return {
    claimPollMs: readInt(env.HAPPIER_AUTOMATION_CLAIM_POLL_MS, 5_000, 1_000, 120_000),
    assignmentsRefreshMs: readInt(env.HAPPIER_AUTOMATION_ASSIGNMENT_REFRESH_MS, 30_000, 5_000, 10 * 60_000),
    leaseDurationMs,
    heartbeatMs: readInt(env.HAPPIER_AUTOMATION_HEARTBEAT_MS, Math.floor(leaseDurationMs / 2), 1_000, 60_000),
  };
}
