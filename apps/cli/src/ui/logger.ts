/**
 * Design decisions:
 * - Logging should be done only through file for debugging, otherwise we might disturb the claude session when in interactive mode
 * - Use info for logs that are useful to the user - this is our UI
 * - File output location: $HAPPIER_HOME_DIR/logs/<date time in local timezone>.log
 * - The file log level is resolved once per process (see logFileLevel.ts) so disabled
 *   debug calls are a near-zero-cost early return (no timestamp, no JSON.stringify).
 * - File writes go through a buffered async appender (see logFileAppender.ts); the buffer
 *   is flushed synchronously on process exit and fatal errors to preserve crash forensics.
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { inspect } from 'node:util'
import { redactBugReportSensitiveText } from '@happier-dev/protocol'
import { writeConsoleErrorBestEffort, writeConsoleLogBestEffort } from '@/utils/writeConsoleBestEffort'
import { pruneLogsByCount } from '@/utils/logs/pruneLogsByCount'
import {
  DAEMON_LOG_SUFFIX,
  LOG_FILE_SUFFIX,
  resolveCrashedSessionLogKeepCount,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
} from '@/utils/logs/logRetention'
import { BufferedFileAppender } from './logFileAppender'
import { isFileLogLevelEnabled, resolveFileLogLevel, type FileLogLevel } from './logFileLevel'
// Note: readDaemonState is imported lazily inside listDaemonLogFiles() to avoid
// circular dependency: logger.ts ↔ persistence.ts

const MAX_FATAL_ERROR_LOG_CHARS = 50_000

function readStringPropertyBestEffort(value: object, key: 'message' | 'name' | 'stack'): string | null {
  try {
    const candidate = (value as Record<string, unknown>)[key]
    return typeof candidate === 'string' && candidate.trim() ? candidate : null
  } catch {
    return null
  }
}

function formatFatalErrorForLog(error: unknown): string {
  try {
    let detail: string
    if (error && typeof error === 'object') {
      const stack = readStringPropertyBestEffort(error, 'stack')
      const message = readStringPropertyBestEffort(error, 'message')
      const name = readStringPropertyBestEffort(error, 'name')
      detail = stack ?? (message ? `${name ?? 'Error'}: ${message}` : 'Unknown error')
    } else if (typeof error === 'string') {
      detail = error
    } else {
      try {
        detail = String(error ?? 'Unknown error')
      } catch {
        detail = 'Unknown error'
      }
    }

    const redacted = redactBugReportSensitiveText(detail)
    return redacted.length > MAX_FATAL_ERROR_LOG_CHARS
      ? `${redacted.slice(0, MAX_FATAL_ERROR_LOG_CHARS)}\n…[truncated]`
      : redacted
  } catch {
    return 'Unknown error'
  }
}

/**
 * Consistent date/time formatting functions
 */
function createTimestampForFilename(date: Date = new Date()): string {
  return date.toLocaleString('sv-SE', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/[: ]/g, '-').replace(/,/g, '') + '-pid-' + process.pid
}

function createTimestampForLogEntry(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename()
  const filename = configuration.isDaemonProcess ? `${timestamp}${DAEMON_LOG_SUFFIX}` : `${timestamp}${LOG_FILE_SUFFIX}`
  return join(configuration.logsDir, filename)
}

async function pruneDaemonLogsForCurrentLogger(logFilePath: string): Promise<void> {
  try {
    mkdirSync(dirname(logFilePath), { recursive: true })
    appendFileSync(logFilePath, '')
  } catch {
    // Best-effort pruning only.
  }
  await pruneLogsByCount({
    dir: configuration.logsDir,
    suffix: DAEMON_LOG_SUFFIX,
    keepCount: resolveDaemonLogKeepCount(),
    keepPath: logFilePath,
  }).catch(() => ({ pruned: 0 }))
}

async function pruneSessionLogsForCurrentLogger(logFilePath: string): Promise<void> {
  const keepCount = resolveSessionLogKeepCount()
  await pruneLogsByCount({
    dir: configuration.logsDir,
    suffix: LOG_FILE_SUFFIX,
    excludeSuffix: DAEMON_LOG_SUFFIX,
    keepCount,
    keepPath: logFilePath,
    keepPaths: [
      ...resolveCrashedSessionLogKeepPaths(configuration.logsDir),
      ...resolveLiveSessionLogKeepPaths(configuration.logsDir, keepCount),
    ],
  }).catch(() => ({ pruned: 0 }))
}

type CrashedSessionExitReportReference = Readonly<{
  pid: number
  observedAt: number
}>

function readNonZeroExitReportReference(path: string): CrashedSessionExitReportReference | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { pid?: unknown; code?: unknown; signal?: unknown };
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
      ? record.pid
      : null;
    if (pid === null) return null;
    const crashed = (typeof record.code === 'number' && record.code !== 0)
      || (typeof record.signal === 'string' && record.signal.trim().length > 0)
    if (!crashed) return null
    const observedAt = typeof (record as { observedAt?: unknown }).observedAt === 'number'
      && Number.isFinite((record as { observedAt?: number }).observedAt)
      ? Math.trunc((record as { observedAt: number }).observedAt)
      : Math.trunc(statSync(path).mtimeMs)
    return { pid, observedAt }
  } catch {
    return null;
  }
}

function resolveCrashedSessionLogKeepPaths(logsDir: string): string[] {
  try {
    const keepCount = resolveCrashedSessionLogKeepCount();
    if (keepCount <= 0) return [];
    const sessionExitDir = join(logsDir, 'session-exit');
    const crashedPids = readdirSync(sessionExitDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => readNonZeroExitReportReference(join(sessionExitDir, file)))
      .filter((entry): entry is CrashedSessionExitReportReference => entry !== null)
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, keepCount)
      .map((entry) => entry.pid);
    if (crashedPids.length === 0) return [];
    const crashedPidSet = new Set(crashedPids);
    return readdirSync(logsDir)
      .filter((file) => file.endsWith(LOG_FILE_SUFFIX) && !file.endsWith(DAEMON_LOG_SUFFIX))
      .filter((file) => {
        const match = /-pid-(\d+)\.log$/.exec(file);
        return match ? crashedPidSet.has(Number(match[1])) : false;
      })
      .map((file) => join(logsDir, file));
  } catch {
    return [];
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'EPERM',
    )
  }
}

function resolveLiveSessionLogKeepPaths(logsDir: string, keepCount: number): string[] {
  try {
    const livenessByPid = new Map<number, boolean>()
    return readdirSync(logsDir)
      .filter((file) => file.endsWith(LOG_FILE_SUFFIX) && !file.endsWith(DAEMON_LOG_SUFFIX))
      .sort((a, b) => a < b ? 1 : a > b ? -1 : 0)
      .slice(Math.max(0, keepCount))
      .filter((file) => {
        const match = /-pid-(\d+)\.log$/.exec(file)
        if (!match) return false
        const pid = Number(match[1])
        if (!Number.isSafeInteger(pid) || pid <= 0) return false
        const cached = livenessByPid.get(pid)
        if (cached !== undefined) return cached
        const alive = isProcessAlive(pid)
        livenessByPid.set(pid, alive)
        return alive
      })
      .map((file) => join(logsDir, file))
  } catch {
    return []
  }
}

function pruneLogsForCurrentLogger(logFilePath: string): void {
  if (configuration.isDaemonProcess) {
    void pruneDaemonLogsForCurrentLogger(logFilePath)
    return
  }
  void pruneSessionLogsForCurrentLogger(logFilePath)
}

type LoggerFlushHookState = {
  registered: boolean
  flushers: Set<() => void>
}

declare global {
  // eslint-disable-next-line no-var
  var __HAPPIER_LOGGER_FLUSH_HOOK_STATE__: LoggerFlushHookState | undefined
}

function getLoggerFlushHookState(): LoggerFlushHookState {
  if (!globalThis.__HAPPIER_LOGGER_FLUSH_HOOK_STATE__) {
    globalThis.__HAPPIER_LOGGER_FLUSH_HOOK_STATE__ = {
      registered: false,
      flushers: new Set(),
    }
  }
  return globalThis.__HAPPIER_LOGGER_FLUSH_HOOK_STATE__
}

function registerLoggerFlushHook(flush: () => void): void {
  const state = getLoggerFlushHookState()
  state.flushers.add(flush)
  if (state.registered) return

  const flushAll = () => {
    for (const flusher of state.flushers) {
      try {
        flusher()
      } catch {
        // Never let flush coordination break process exit.
      }
    }
  }

  process.on('exit', flushAll)
  process.on('uncaughtExceptionMonitor', flushAll)
  state.registered = true
}

class Logger {
  private dangerouslyUnencryptedServerLoggingUrl: string | undefined
  private hasLoggedFileWriteError: boolean = false
  private readonly fileLogLevel: FileLogLevel
  private readonly debugFileEnabled: boolean
  private readonly infoFileEnabled: boolean
  private readonly warnFileEnabled: boolean
  private readonly fileAppender: BufferedFileAppender

  constructor(
    public readonly logFilePath = getSessionLogPath()
  ) {
    pruneLogsForCurrentLogger(this.logFilePath)

    this.fileLogLevel = resolveFileLogLevel({ env: process.env, isDaemonProcess: configuration.isDaemonProcess })
    this.debugFileEnabled = isFileLogLevelEnabled(this.fileLogLevel, 'debug')
    this.infoFileEnabled = isFileLogLevelEnabled(this.fileLogLevel, 'info')
    this.warnFileEnabled = isFileLogLevelEnabled(this.fileLogLevel, 'warn')
    this.fileAppender = new BufferedFileAppender({
      filePath: this.logFilePath,
      onWriteError: (error) => this.handleFileWriteError(error),
    })

    // Crash forensics: drain the buffered appender synchronously on process exit and on
    // fatal errors. `uncaughtExceptionMonitor` observes without altering crash semantics.
    registerLoggerFlushHook(() => this.flushSync())

    // Remote logging enabled only when explicitly set with server URL
    if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING
      && process.env.HAPPIER_SERVER_URL) {
      this.dangerouslyUnencryptedServerLoggingUrl = process.env.HAPPIER_SERVER_URL
      writeConsoleLogBestEffort(chalk.yellow('[REMOTE LOGGING] Sending logs to server for AI debugging'))
    }
  }

  // Use local timezone for simplicity of locating the logs,
  // in practice you will not need absolute timestamps
  localTimezoneTimestamp(): string {
    return createTimestampForLogEntry()
  }

  debug(message: string, ...args: unknown[]): void {
    // Near-zero-cost when debug file logging is disabled: no timestamp, no stringify.
    if (!this.debugFileEnabled) return
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)
  }

  debugLargeJson(
    message: string,
    object: unknown,
    maxStringLength: number = 100,
    maxArrayLength: number = 10,
  ): void {
    // Large-payload logging stays behind the explicit DEBUG opt-in (independent of the
    // daemon's default debug level) because even truncated payload dumps are expensive.
    if (!process.env.DEBUG) return;

    // Some of our messages are huge, but we still want to show them in the logs
    const visited = new WeakSet<object>()
    const truncateStrings = (obj: unknown): unknown => {
      if (typeof obj === 'string') {
        return obj.length > maxStringLength
          ? obj.substring(0, maxStringLength) + '... [truncated for logs]'
          : obj
      }

      if (typeof obj === 'bigint') {
        return `${obj.toString()}n`
      }

      if (Array.isArray(obj)) {
        if (visited.has(obj)) return '[Circular]'
        visited.add(obj)
        const truncatedArray = obj.map(item => truncateStrings(item)).slice(0, maxArrayLength)
        if (obj.length > maxArrayLength) {
          truncatedArray.push(`... [truncated array for logs up to ${maxArrayLength} items]` as unknown)
        }
        return truncatedArray
      }

      if (obj && typeof obj === 'object') {
        if (visited.has(obj)) return '[Circular]'
        visited.add(obj)
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'usage') {
            // Drop usage, not generally useful for debugging
            continue
          }
          result[key] = truncateStrings(value)
        }
        return result
      }

      return obj
    }

    const truncatedObject = truncateStrings(object)
    let json = ''
    try {
      json = JSON.stringify(truncatedObject, null, 2)
    } catch {
      json = inspect(truncatedObject, { depth: 8, maxArrayLength })
    }
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, '\n', json)
  }

  info(message: string, ...args: unknown[]): void {
    this.logToConsole('info', '', message, ...args)
    if (!this.infoFileEnabled) return
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)
  }

  infoFile(message: string, ...args: unknown[]): void {
    if (!this.infoFileEnabled) return
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)
  }

  infoDeveloper(message: string, ...args: unknown[]): void {
    // Developer diagnostics are debug-level file entries.
    this.debug(message, ...args)

    // Write to info if DEBUG mode is on
    if (process.env.DEBUG) {
      this.logToConsole('info', '[DEV]', message, ...args)
    }
  }

  warn(message: string, ...args: unknown[]): void {
    this.logToConsole('warn', '', message, ...args)
    if (!this.warnFileEnabled) return
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, `[WARN] ${message}`, ...args)
  }

  /**
   * Persist an unhandled CLI failure before a detached runner exits. This deliberately
   * records only sanitized Error text: enumerable fields can contain argv or environment
   * snapshots and are never serialized. The write and synchronous drain are best-effort.
   */
  fatal(error: unknown): void {
    try {
      const detail = formatFatalErrorForLog(error)
      this.fileAppender.append(
        `[${this.localTimezoneTimestamp()}] [FATAL] Unhandled CLI error ${detail}\n`,
      )
    } catch {
      try {
        this.fileAppender.append('[FATAL] Unhandled CLI error Unknown error\n')
      } catch {
        // Fatal reporting must never replace or mask the originating failure.
      }
    } finally {
      try {
        this.flushSync()
      } catch {
        // Keep fatal reporting best-effort even if the logger implementation evolves.
      }
    }
  }

  getLogPath(): string {
    return this.logFilePath
  }

  /**
   * Synchronously drain buffered log lines to disk. Wired to exit/fatal handlers;
   * also useful in tests and right before intentional hard exits. Never throws.
   */
  flushSync(): void {
    this.fileAppender.flushSync()
  }

  private logToConsole(level: 'debug' | 'error' | 'info' | 'warn', prefix: string, message: string, ...args: unknown[]): void {
    switch (level) {
      case 'debug': {
        writeConsoleLogBestEffort(chalk.gray(prefix), message, ...args)
        break
      }

      case 'error': {
        writeConsoleErrorBestEffort(chalk.red(prefix), message, ...args)
        break
      }

      case 'info': {
        writeConsoleLogBestEffort(chalk.blue(prefix), message, ...args)
        break
      }

      case 'warn': {
        writeConsoleLogBestEffort(chalk.yellow(prefix), message, ...args)
        break
      }

      default: {
        this.debug('Unknown log level:', level)
        writeConsoleLogBestEffort(chalk.blue(prefix), message, ...args)
        break
      }
    }
  }

  private async sendToRemoteServer(level: string, message: string, ...args: unknown[]): Promise<void> {
    if (!this.dangerouslyUnencryptedServerLoggingUrl) return

    try {
      await fetch(this.dangerouslyUnencryptedServerLoggingUrl + '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: `${message} ${args.map(a => {
            if (a instanceof Error) return a.stack || a.message
            if (typeof a === 'object') {
              // Check for Error-like objects (cross-realm Errors where instanceof fails)
              if (a && 'stack' in (a as object)) return (a as Error).stack || String(a)
              try { return JSON.stringify(a, null, 2) } catch { return String(a) }
            }
            return String(a)
          }).join(' ')}`,
          source: 'cli',
          platform: process.platform
        })
      })
    } catch (error) {
      // Silently fail to avoid disrupting the session
    }
  }

  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    const logLine = `${prefix} ${message} ${args.map(arg => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack || arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        // Circular references, cross-realm Error objects, BigInt, etc.
        if (arg && typeof arg === 'object' && 'stack' in arg) return (arg as Error).stack || String(arg)
        return String(arg)
      }
    }).join(' ')}\n`

    // Send to remote server if configured
    if (this.dangerouslyUnencryptedServerLoggingUrl) {
      // Determine log level from prefix
      let level = 'info'
      if (prefix.includes(this.localTimezoneTimestamp())) {
        level = 'debug'
      }
      // Fire and forget, with explicit .catch to prevent unhandled rejection
      this.sendToRemoteServer(level, message, ...args).catch(() => {
        // Silently ignore remote logging errors to prevent loops
      })
    }

    // Buffered async append; flushed on a short interval and synchronously on exit.
    this.fileAppender.append(logLine)
  }

  private handleFileWriteError(error: unknown): void {
    // Never throw from logging: log files are best-effort and should not break the CLI.
    // When DEBUG is set, surface the first write failure for easier debugging.
    if (process.env.DEBUG && !this.hasLoggedFileWriteError) {
      writeConsoleErrorBestEffort('[DEV MODE ONLY] Failed to append to log file:', error)
      this.hasLoggedFileWriteError = true
    }
    // In production (and after the first DEBUG warning), fail silently to avoid disturbing the session.
  }
}

// Will be initialized immideately on startup
export let logger = new Logger()

/**
 * Information about a log file on disk
 */
export type LogFileInfo = {
  file: string;
  path: string;
  modified: Date;
};

/**
 * List daemon log files in descending modification time order.
 * Returns up to `limit` entries; empty array if none.
 */
export async function listDaemonLogFiles(limit: number = 50): Promise<LogFileInfo[]> {
  try {
    const logsDir = configuration.logsDir;
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith(DAEMON_LOG_SUFFIX))
      .map(file => {
        const fullPath = join(logsDir, file);
        const stats = statSync(fullPath);
        return { file, path: fullPath, modified: stats.mtime } as LogFileInfo;
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Prefer the path persisted by the daemon if present (return 0th element if present)
    try {
      // Lazy import to avoid circular dependency: logger.ts ↔ persistence.ts
      const { readDaemonState } = await import('@/persistence');
      const state = await readDaemonState();

      if (!state) {
        return logs;
      }

      if (state.daemonLogPath && existsSync(state.daemonLogPath)) {
        const stats = statSync(state.daemonLogPath);
        const persisted: LogFileInfo = {
          file: basename(state.daemonLogPath),
          path: state.daemonLogPath,
          modified: stats.mtime
        };
        const idx = logs.findIndex(l => l.path === persisted.path);
        if (idx >= 0) {
          const [found] = logs.splice(idx, 1);
          logs.unshift(found);
        } else {
          logs.unshift(persisted);
        }
      }
    } catch {
      // Ignore errors reading daemon state; fall back to directory listing
    }

    return logs.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/**
 * Get the most recent daemon log file, or null if none exist.
 */
export async function getLatestDaemonLog(): Promise<LogFileInfo | null> {
  const [latest] = await listDaemonLogFiles(1);
  return latest || null;
}
