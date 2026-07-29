export const DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS = 5 * 60_000;

function resolveBoundedTimeout(
  raw: string | undefined,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export function resolveDaemonStartedSessionReportRetryPolicy(
  env: NodeJS.ProcessEnv,
): Readonly<{
  retryTimeoutMs: number;
  retryIntervalMs: number;
  reportAttemptTimeoutMs: number;
  retirementHorizonMs: number;
}> {
  const retryTimeoutMs = resolveBoundedTimeout(
    env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS,
    90_000,
    { min: 0, max: 120_000 },
  );
  const retryIntervalMs = resolveBoundedTimeout(
    env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS,
    250,
    { min: 50, max: 10_000 },
  );
  const reportAttemptTimeoutMs = resolveBoundedTimeout(
    env.HAPPIER_DAEMON_REPORT_SESSION_HTTP_TIMEOUT_MS,
    10_000,
    { min: 100, max: 30_000 },
  );
  return {
    retryTimeoutMs,
    retryIntervalMs,
    reportAttemptTimeoutMs,
    retirementHorizonMs:
      retryTimeoutMs
      + Math.min(
          reportAttemptTimeoutMs,
          Math.max(100, retryTimeoutMs),
        )
      + retryIntervalMs,
  };
}
