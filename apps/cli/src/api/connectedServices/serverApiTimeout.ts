export const CONNECTED_SERVICES_SERVER_API_TIMEOUT_ENV_KEY = 'HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS';
export const DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS = 30_000;

const MIN_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS = 1_000;
export const MAX_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS = 120_000;

type TimeoutEnv = Readonly<Record<string, string | undefined>>;

export function resolveConnectedServicesServerApiTimeoutMs(
  env: TimeoutEnv = process.env,
): number {
  const raw = env[CONNECTED_SERVICES_SERVER_API_TIMEOUT_ENV_KEY]?.trim();
  if (!raw) return DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS;

  const timeoutMs = Math.trunc(parsed);
  if (timeoutMs <= 0) return DEFAULT_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS;
  return Math.max(
    MIN_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS,
    Math.min(MAX_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS, timeoutMs),
  );
}
