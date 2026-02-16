function parseTimeoutMs(raw: unknown): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function resolveConnectedServiceQuotasDaemonOptions(env: NodeJS.ProcessEnv): Readonly<{
  fetchTimeoutMs: number;
}> {
  const parsed = parseTimeoutMs(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_FETCH_TIMEOUT_MS);
  const timeoutMs = parsed === null ? 15_000 : Math.max(1_000, Math.min(120_000, Math.trunc(parsed)));
  return { fetchTimeoutMs: timeoutMs };
}

