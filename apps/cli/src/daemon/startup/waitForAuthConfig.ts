const WAIT_FOR_AUTH_ENABLED_VALUES = new Set(['1', 'true', 'yes']);
const DEFAULT_WAIT_FOR_AUTH_TIMEOUT_MS = 10 * 60_000;

export function resolveWaitForAuthConfig(
  env: NodeJS.ProcessEnv,
): Readonly<{ waitForAuthEnabled: boolean; waitForAuthTimeoutMs: number }> {
  const waitForAuthEnabled = WAIT_FOR_AUTH_ENABLED_VALUES.has((env.HAPPIER_DAEMON_WAIT_FOR_AUTH ?? '').toLowerCase());
  const rawTimeoutMs = Number(env.HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS ?? '');
  const waitForAuthTimeoutMs =
    Number.isFinite(rawTimeoutMs) && rawTimeoutMs >= 0 ? rawTimeoutMs : DEFAULT_WAIT_FOR_AUTH_TIMEOUT_MS;

  return {
    waitForAuthEnabled,
    waitForAuthTimeoutMs,
  };
}
