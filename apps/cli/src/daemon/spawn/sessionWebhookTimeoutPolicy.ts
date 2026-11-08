export { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';

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

export function resolveSessionReportRetryPolicy(
  env: NodeJS.ProcessEnv,
  startedBy = 'daemon',
): Readonly<{
  retryTimeoutMs: number;
  retryIntervalMs: number;
  reportAttemptTimeoutMs: number;
  retirementHorizonMs: number;
}> {
  const autostart = (env.HAPPIER_SESSION_AUTOSTART_DAEMON ?? '').trim().toLowerCase();
  const daemonAutostartEnabled = autostart === '1' || autostart === 'true' || autostart === 'yes' || autostart === 'y';
  const retryTimeoutMs = resolveBoundedTimeout(
    env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS,
    startedBy === 'daemon' ? 90_000 : daemonAutostartEnabled ? 30_000 : 10_000,
    { min: 0, max: 120_000 },
  );
  const retryIntervalMs = resolveBoundedTimeout(
    env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS,
    250,
    { min: 50, max: 10_000 },
  );
  const reportAttemptTimeoutMs = resolveBoundedTimeout(
    env.HAPPIER_DAEMON_REPORT_SESSION_HTTP_TIMEOUT_MS,
    startedBy === 'daemon' ? 10_000 : 2_500,
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
