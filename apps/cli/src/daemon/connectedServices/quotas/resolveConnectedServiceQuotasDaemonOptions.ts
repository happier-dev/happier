import { parseOptionalBooleanEnv } from '@happier-dev/protocol/env/parseBooleanEnv';

function parsePositiveInt(raw: unknown, maximum = 2_147_483_647): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  // Timer options use the native delay ceiling; counts use the safe integer domain.
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) return null;
  return parsed;
}

function parseFloatValue(raw: unknown): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function resolveConnectedServiceQuotasDaemonOptions(env: NodeJS.ProcessEnv): Readonly<{
  fetchTimeoutMs?: number;
  quotaPersistenceMaxConsecutiveFailures?: number;
  discoveryEnabled: boolean;
  discoveryIntervalMs: number;
  failureBackoffMinMs: number;
  failureBackoffMaxMs: number;
  failureBackoffJitterPct: number;
}> {
  const timeoutMs = parsePositiveInt(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS);
  const quotaPersistenceMaxConsecutiveFailures = parsePositiveInt(
    env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES,
    Number.MAX_SAFE_INTEGER,
  );

  const discoveryEnabled = parseOptionalBooleanEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED);
  const discoveryIntervalParsed = parsePositiveInt(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_INTERVAL_MS);
  const discoveryIntervalMs =
    discoveryIntervalParsed ?? 15 * 60_000;

  const failureMinParsed = parsePositiveInt(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_MIN_MS);
  const failureBackoffMinMs = failureMinParsed ?? 30_000;

  const failureMaxParsed = parsePositiveInt(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_MAX_MS);
  const failureBackoffMaxMsRaw = failureMaxParsed ?? 10 * 60_000;
  const failureBackoffMaxMs = Math.max(failureBackoffMinMs, failureBackoffMaxMsRaw);

  const jitterParsed = parseFloatValue(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_JITTER_PCT);
  const failureBackoffJitterPct = jitterParsed === null ? 0.2 : Math.min(1, Math.max(0, jitterParsed));

  return {
    ...(timeoutMs === null ? {} : { fetchTimeoutMs: timeoutMs }),
    ...(quotaPersistenceMaxConsecutiveFailures === null ? {} : { quotaPersistenceMaxConsecutiveFailures }),
    discoveryEnabled: discoveryEnabled === null ? true : discoveryEnabled,
    discoveryIntervalMs,
    failureBackoffMinMs,
    failureBackoffMaxMs,
    failureBackoffJitterPct,
  };
}
