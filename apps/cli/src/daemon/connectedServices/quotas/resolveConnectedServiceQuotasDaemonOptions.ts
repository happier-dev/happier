function parseTimeoutMs(raw: unknown): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parsePositiveInt(raw: unknown): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseBoolean(raw: unknown): boolean | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'y' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'n' || value === 'off') return false;
  return null;
}

function parseFloatValue(raw: unknown): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function resolveConnectedServiceQuotasDaemonOptions(env: NodeJS.ProcessEnv): Readonly<{
  fetchTimeoutMs: number;
  discoveryEnabled: boolean;
  discoveryIntervalMs: number;
  failureBackoffMinMs: number;
  failureBackoffMaxMs: number;
  failureBackoffJitterPct: number;
}> {
  const parsed = parseTimeoutMs(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS);
  const timeoutMs = parsed === null ? 15_000 : Math.max(1_000, Math.min(120_000, Math.trunc(parsed)));

  const discoveryEnabled = parseBoolean(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED);
  const discoveryIntervalParsed = parsePositiveInt(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_INTERVAL_MS);
  const discoveryIntervalMs =
    discoveryIntervalParsed === null ? 60_000 : Math.max(5_000, Math.min(30 * 60_000, Math.trunc(discoveryIntervalParsed)));

  const failureMinParsed = parsePositiveInt(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_MIN_MS);
  const failureBackoffMinMs = failureMinParsed === null ? 30_000 : Math.max(1_000, Math.min(30 * 60_000, Math.trunc(failureMinParsed)));

  const failureMaxParsed = parsePositiveInt(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_MAX_MS);
  const failureBackoffMaxMsRaw = failureMaxParsed === null ? 10 * 60_000 : Math.max(1_000, Math.min(30 * 60_000, Math.trunc(failureMaxParsed)));
  const failureBackoffMaxMs = Math.max(failureBackoffMinMs, failureBackoffMaxMsRaw);

  const jitterParsed = parseFloatValue(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FAILURE_BACKOFF_JITTER_PCT);
  const failureBackoffJitterPct = jitterParsed === null ? 0.2 : Math.min(1, Math.max(0, jitterParsed));

  return {
    fetchTimeoutMs: timeoutMs,
    discoveryEnabled: discoveryEnabled === null ? true : discoveryEnabled,
    discoveryIntervalMs,
    failureBackoffMinMs,
    failureBackoffMaxMs,
    failureBackoffJitterPct,
  };
}
