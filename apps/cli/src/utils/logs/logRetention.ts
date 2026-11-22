/**
 * Centralized log-retention policy for ~/.happier/logs.
 *
 * One log file is created per process boot, so retention is count-based:
 * - daemon logs (`*-daemon.log`) keep the newest {@link DEFAULT_DAEMON_LOG_KEEP_COUNT}
 * - session logs (all other `*.log`) keep the newest {@link DEFAULT_SESSION_LOG_KEEP_COUNT}
 * - non-zero crashed session logs are preserved outside the normal budget, capped by
 *   {@link DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT}
 *
 * Both budgets are env-overridable (`HAPPIER_DAEMON_LOG_KEEP_COUNT`,
 * `HAPPIER_SESSION_LOG_KEEP_COUNT`, `HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT`) for
 * support/debugging scenarios.
 */

import { DEFAULT_BUG_REPORTS_CAPABILITIES } from '@happier-dev/protocol';

export const DAEMON_LOG_SUFFIX = '-daemon.log';
export const LOG_FILE_SUFFIX = '.log';

export const DEFAULT_DAEMON_LOG_KEEP_COUNT = 50;
export const DEFAULT_SESSION_LOG_KEEP_COUNT = 200;
export const DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT = 20;

/** Recent log files the diagnostic surfaces name (doctor listing, bug-report machine diagnostics). */
export const DIAGNOSTIC_RECENT_DAEMON_LOG_COUNT = 5;
export const DIAGNOSTIC_RECENT_SESSION_LOG_COUNT = 10;

/**
 * Newest bytes one log file keeps readable. A bug report reads at most this tail of the
 * daemon and session logs: it is the default per-artifact upload limit, the most a user can share.
 */
export const LOG_FILE_TAIL_WINDOW_BYTES = DEFAULT_BUG_REPORTS_CAPABILITIES.maxArtifactBytes;

/**
 * Total bytes all logs in the logs directory may use (owner ruling 2026-11-15, "Growth decisions
 * final"). It exceeds the reach of the diagnostic surfaces (recent daemon + session logs and
 * preserved crashed-session logs, each with its full shareable tail). Oldest logs go first; the
 * current, live and crashed logs are never removed for it.
 */
export const LOG_TOTAL_BUDGET_BYTES = 1024 * 1024 * 1024;

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
