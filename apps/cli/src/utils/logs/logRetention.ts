export const DAEMON_LOG_SUFFIX = '-daemon.log';
export const LOG_FILE_SUFFIX = '.log';
/** Launch-owned stderr capture for the current daemon, never an Account setting. */
export const DAEMON_STDERR_LOG_PATH_ENV = 'HAPPIER_DAEMON_STDERR_LOG_PATH';

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

function resolveKeepCount(rawValue: string | undefined): number | undefined {
  if (!rawValue?.trim()) return undefined;
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function resolveDaemonLogKeepCount(env: EnvLike = process.env): number | undefined {
  return resolveKeepCount(env.HAPPIER_DAEMON_LOG_KEEP_COUNT);
}

export function resolveSessionLogKeepCount(env: EnvLike = process.env): number | undefined {
  return resolveKeepCount(env.HAPPIER_SESSION_LOG_KEEP_COUNT);
}

export function resolveCrashedSessionLogKeepCount(env: EnvLike = process.env): number {
  return resolveKeepCount(env.HAPPIER_CRASHED_SESSION_LOG_KEEP_COUNT) ?? DEFAULT_CRASHED_SESSION_LOG_KEEP_COUNT;
}

export function resolveLogRetention(input: Readonly<{ settings: Readonly<{ logRetentionDays: number | null }>; env?: EnvLike }>) {
  return { days: input.settings.logRetentionDays, daemonKeepCount: resolveDaemonLogKeepCount(input.env),
    sessionKeepCount: resolveSessionLogKeepCount(input.env), crashedSessionKeepCount: resolveCrashedSessionLogKeepCount(input.env) };
}

export function storageLogRoots(happyHomeDir: string): readonly string[] {
  const pluginPaths = resolvePluginStorePaths({ happyHomeDir });
  return [join(happyHomeDir, 'logs'), join(happyHomeDir, 'cli', 'logs', 'subprocess'), join(happyHomeDir, 'tool-traces'),
    pluginPaths.logsDir, join(pluginPaths.stateDir, 'managed-servers', 'logs')];
}

export function resolveCrashedSessionLogKeepPaths(logsDir: string, env: EnvLike = process.env): string[] {
  const keepCount = resolveCrashedSessionLogKeepCount(env);
  if (keepCount <= 0) return [];
  try {
    const sessionExitDir = join(logsDir, 'session-exit');
    const reports = readdirSync(sessionExitDir).filter(name => name.endsWith('.json')).flatMap(name => {
      const path = join(sessionExitDir, name);
      try {
        const report: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!report || typeof report !== 'object' || Array.isArray(report)) return [];
        const value = report as Record<string, unknown>;
        if (!(typeof value.code === 'number' && value.code !== 0) && !(typeof value.signal === 'string' && value.signal.trim())) return [];
        if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return [];
        return [{ path, pid: value.pid, observedAt: typeof value.observedAt === 'number' && Number.isFinite(value.observedAt) ? value.observedAt : statSync(path).mtimeMs }];
      } catch { return []; }
    }).sort((a, b) => b.observedAt - a.observedAt).slice(0, keepCount);
    const pids = new Set(reports.map(report => report.pid));
    return [...reports.map(report => report.path), ...readdirSync(logsDir)
      .filter(name => name.endsWith(LOG_FILE_SUFFIX) && !name.endsWith(DAEMON_LOG_SUFFIX))
      .filter(name => { const match = /-pid-(\d+)\.log$/.exec(name); return match !== null && pids.has(Number(match[1])); })
      .map(name => join(logsDir, name))];
  } catch { return []; }
}

/** Logs (session or daemon) whose writing process is still running. */
export function resolveLiveProcessLogKeepPaths(logsDir: string): string[] {
  try {
    const liveness = new Map<number, boolean>();
    return readdirSync(logsDir).filter(name => name.endsWith(LOG_FILE_SUFFIX)).filter(name => {
        const match = /-pid-(\d+)(?:-daemon)?\.log$/.exec(name);
        if (!match) return false;
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        let alive = liveness.get(pid);
        if (alive === undefined) { alive = isPidPresent(pid); liveness.set(pid, alive); }
        return alive;
      }).map(name => join(logsDir, name));
  } catch { return []; }
}

export type LogRetentionPassResult = Readonly<{ pruned: number; freedBytes: number; nextDueAtMs: number | null }>;
export function createLogRetentionOwner(input: Readonly<{
  happyHomeDir: string;
  currentLogPaths(): readonly string[] | Promise<readonly string[]>;
  additionalRoots?: () => readonly string[];
  env?: EnvLike;
  onError(error: unknown): void;
}>) {
  return {
    async run(days: number | null, nowMs: number, operation: Readonly<{ beforeEffect?: () => Promise<void> }> = {}): Promise<LogRetentionPassResult> {
      const logsDir = join(input.happyHomeDir, 'logs');
      const policy = resolveLogRetention({ settings: { logRetentionDays: days }, env: input.env });
      const stderrPath = (input.env ?? process.env)[DAEMON_STDERR_LOG_PATH_ENV];
      const keepPaths = [...await input.currentLogPaths(), ...(stderrPath ? [stderrPath] : []), ...resolveCrashedSessionLogKeepPaths(logsDir, input.env), ...resolveLiveProcessLogKeepPaths(logsDir)];
      const result = { pruned: 0, freedBytes: 0, nextDueAtMs: null as number | null };
      let stopped = false;
      const ageMs = days === null ? null : days * 86_400_000;
      const measure = async (paths: readonly string[]) => {
        const { measureNativeDisk } = await import('@/storage/measure/nativeDiskMeasure');
        const measured = await measureNativeDisk({ paths: [...paths] });
        return new Map(measured.perPath.map(item => [item.path, item.exclusiveBytes]));
      };
      async function prune(dir: string, suffix: string, excludeSuffix?: string, keepCount?: number, maxTotalBytes?: number) {
        // The budget pass spans daemon and session logs after their own age/count passes.
        const applyAge = maxTotalBytes === undefined;
        if (stopped) return;
        try {
          const pass = await pruneLogs({ dir, suffix, excludeSuffix, keepCount, maxTotalBytes, keepPaths, beforeEffect: operation.beforeEffect,
            ...(ageMs === null || !applyAge ? {} : { olderThanMs: nowMs - ageMs }), measure });
          result.pruned += pass.pruned; result.freedBytes += pass.freedBytes;
          for (const failure of pass.failures) {
            if (failure.error instanceof Error && failure.error.name === 'AbortError') stopped = true;
            input.onError(failure.error);
          }
          if (applyAge && ageMs !== null && pass.oldestRemainingAtMs !== null) result.nextDueAtMs = Math.min(result.nextDueAtMs ?? Infinity, pass.oldestRemainingAtMs + ageMs);
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') stopped = true;
          input.onError(error);
        }
      }
      const visited = new Set<string>();
      async function visit(dir: string) {
        if (stopped || visited.has(dir)) return; visited.add(dir);
        let names: string[];
        try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') input.onError(error); return; }
        if (dir === logsDir) {
          await prune(dir, DAEMON_LOG_SUFFIX, undefined, policy.daemonKeepCount);
          await prune(dir, LOG_FILE_SUFFIX, DAEMON_LOG_SUFFIX, policy.sessionKeepCount);
          await prune(dir, LOG_FILE_SUFFIX, undefined, undefined, LOG_TOTAL_BUDGET_BYTES);
        } else await prune(dir, '');
        for (const name of names) {
          if (stopped) break;
          const path = join(dir, name);
          try { const stat = await lstat(path); if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') input.onError(error); }
        }
      }
      for (const root of [...storageLogRoots(input.happyHomeDir), ...(input.additionalRoots?.() ?? [])]) await visit(root);
      return result;
    },
  };
}
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { DEFAULT_BUG_REPORTS_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/bugReportsCapabilities';
import { pruneLogs } from './pruneLogs';
