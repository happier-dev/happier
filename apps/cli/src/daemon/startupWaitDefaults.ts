import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

export const DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_DAEMON_START_WAIT_POLL_MS = 100;
export const DEFAULT_SESSION_AUTOSTART_DAEMON_WAIT_POLL_MS = 250;
export const DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS = DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS;
export const DEFAULT_DAEMON_RESTART_VERIFY_POLL_MS = 250;

export function readDaemonStartWaitTimeoutMs(): number {
  return readPositiveIntEnv(
    'HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS',
    DEFAULT_DAEMON_START_WAIT_TIMEOUT_MS,
  );
}

export function readDaemonStartWaitPollMs(
  defaultPollMs: number = DEFAULT_DAEMON_START_WAIT_POLL_MS,
): number {
  return readPositiveIntEnv('HAPPIER_DAEMON_START_WAIT_POLL_MS', defaultPollMs);
}

export function readDaemonRestartVerifyTimeoutMs(): number {
  return readPositiveIntEnv(
    'HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS',
    DEFAULT_DAEMON_RESTART_VERIFY_TIMEOUT_MS,
  );
}

export function readDaemonRestartVerifyPollMs(): number {
  return readPositiveIntEnv(
    'HAPPIER_DAEMON_RESTART_VERIFY_POLL_MS',
    DEFAULT_DAEMON_RESTART_VERIFY_POLL_MS,
  );
}
