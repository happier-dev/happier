import { parseBooleanEnv } from '@happier-dev/protocol';

const DEFAULT_WAIT_FOR_AUTH_TIMEOUT_MS = 10 * 60_000;

export function resolveWaitForAuthConfig(
  env: NodeJS.ProcessEnv,
): Readonly<{ waitForAuthEnabled: boolean; waitForAuthTimeoutMs: number }> {
  const waitForAuthEnabled = parseBooleanEnv(env.HAPPIER_DAEMON_WAIT_FOR_AUTH, false);
  const rawTimeoutMs = Number(env.HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS ?? '');
  const waitForAuthTimeoutMs =
    Number.isFinite(rawTimeoutMs) && rawTimeoutMs >= 0 ? rawTimeoutMs : DEFAULT_WAIT_FOR_AUTH_TIMEOUT_MS;

  return {
    waitForAuthEnabled,
    waitForAuthTimeoutMs,
  };
}
