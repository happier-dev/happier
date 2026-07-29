export const DAEMON_LOG_SUFFIX = '-daemon.log';
export const LOG_FILE_SUFFIX = '.log';

export const DEFAULT_DAEMON_LOG_KEEP_COUNT = 50;
export const DEFAULT_SESSION_LOG_KEEP_COUNT = 200;
export const DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT = 20;

type EnvLike = Readonly<Record<string, string | undefined>>;

function resolveKeepCount(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function resolveDaemonLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_DAEMON_LOG_KEEP_COUNT, DEFAULT_DAEMON_LOG_KEEP_COUNT);
}

export function resolveSessionLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_SESSION_LOG_KEEP_COUNT, DEFAULT_SESSION_LOG_KEEP_COUNT);
}

export function resolveCrashedSessionLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT, DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT);
}
