/**
 * Design decisions:
 * - Logging should be done only through file for debugging, otherwise we might disturb the claude session when in interactive mode
 * - Use info for logs that are useful to the user - this is our UI
 * - File output location: $HAPPIER_HOME_DIR/logs/<date time in local timezone>.log
 */

import chalk from 'chalk'
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports'
import { configuration } from '../configuration'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { inspect } from 'node:util'
import {
  isPluginInvocationLogRecord,
  type PluginInvocationLogRecord,
} from '@/plugins/runtime/invocation/services/logger'
import { writeConsoleErrorBestEffort, writeConsoleLogBestEffort } from '../utils/writeConsoleBestEffort'
import { BufferedFileAppender } from './logFileAppender'
import { isFileLogLevelEnabled, resolveFileLogLevel, type FileLogLevel } from './logFileLevel'
import { pruneLogsByCount } from '@/utils/logs/pruneLogsByCount'
import {
  DAEMON_LOG_SUFFIX,
  LOG_FILE_SUFFIX,
  resolveCrashedSessionLogKeepCount,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
} from '@/utils/logs/logRetention'
// Note: readDaemonState is imported lazily inside listDaemonLogFiles() to avoid
// circular dependency: logger.ts ↔ persistence.ts

const DEFAULT_PLUGIN_INVOCATION_LOG_READ_LIMIT = 100
const MAX_PLUGIN_INVOCATION_LOG_READ_LIMIT = 500
const MAX_PLUGIN_INVOCATION_LOG_READ_BYTES = 1024 * 1024
const MAX_FATAL_ERROR_LOG_CHARS = 50_000

function readStringPropertyBestEffort(value: object, key: 'message' | 'name' | 'stack'): string | null {
  try {
    const candidate = (value as Record<string, unknown>)[key]
    return typeof candidate === 'string' && candidate.trim() ? candidate : null
  } catch {
    return null
  }
}

/**
 * An Error carries no enumerable own properties, so `JSON.stringify` renders it
 * as `{}`. A top-level Error argument was already unwrapped by hand at each
 * serialization site, but the shape these are actually logged in — an Error
 * CARRIED by an object, `{ pid, error }` — reached the log file as
 * `{"pid":95632,"error":{}}`, which is a failure report with the failure removed.
 * Errors are therefore described here, at the boundary, once, at any depth.
 */
function isErrorLikeForLog(value: unknown): value is object {
  if (value instanceof Error) return true
  if (!value || typeof value !== 'object') return false
  try {
    // Cross-realm Errors fail `instanceof`, so shape is the only usable test.
    return 'stack' in value && 'message' in value
  } catch {
    return false
  }
}

function readUnknownPropertyBestEffort(value: object, key: 'code' | 'cause'): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function describeErrorForLog(error: object): Record<string, unknown> {
  const name = readStringPropertyBestEffort(error, 'name')
  const message = readStringPropertyBestEffort(error, 'message')
  // `stack` normally opens with `name: message`, but a cross-realm or trimmed
  // Error may carry only one of the three, so each is emitted on its own.
  const stack = readStringPropertyBestEffort(error, 'stack')
  const code = readUnknownPropertyBestEffort(error, 'code')
  const cause = readUnknownPropertyBestEffort(error, 'cause')
  return {
    ...(name ? { name } : {}),
    ...(message ? { message } : {}),
    ...(stack ? { stack } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(cause === undefined ? {} : { cause }),
  }
}

/**
 * One replacer per `JSON.stringify` call: the seen-set has to be scoped to the
 * call, or a cause chain that loops back would be dropped from later logs.
 */
function createErrorAwareLogReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (!isErrorLikeForLog(value)) return value
    if (seen.has(value)) return '[Circular error]'
    seen.add(value)
    return describeErrorForLog(value)
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

export type PluginInvocationLogQuery = Readonly<{
  pluginId: string
  generation?: string
  correlationId?: string
  cursor?: number
  limit?: number
}>

export type PluginInvocationLogReadResult = Readonly<{
  kind: 'available'
  records: readonly PluginInvocationLogRecord[]
  cursor: number
  hasMore: boolean
}> | Readonly<{
  kind: 'unavailable'
}>

function normalizePluginInvocationLogReadLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return DEFAULT_PLUGIN_INVOCATION_LOG_READ_LIMIT
  return Math.min(MAX_PLUGIN_INVOCATION_LOG_READ_LIMIT, Math.max(1, value))
}

function normalizePluginInvocationLogReadCursor(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return 0
  return value
}

function recordMatchesPluginInvocationLogQuery(
  record: PluginInvocationLogRecord,
  query: PluginInvocationLogQuery,
): boolean {
  if (record.context.plugin.id !== query.pluginId) return false
  if (query.generation !== undefined && record.context.generation !== query.generation) return false
  return query.correlationId === undefined || record.context.correlationId === query.correlationId
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

function resolveLogsDir(): string {
  const configuredLogsDir = typeof configuration.logsDir === 'string' ? configuration.logsDir.trim() : ''
  if (configuredLogsDir.length > 0) {
    return configuredLogsDir
  }

  const configuredHappyHomeDir = typeof configuration.happyHomeDir === 'string' ? configuration.happyHomeDir.trim() : ''
  const happyHomeDir = configuredHappyHomeDir.length > 0 ? configuredHappyHomeDir : join(homedir(), '.happier')
  return join(happyHomeDir, 'logs')
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename()
  const filename = configuration.isDaemonProcess ? `${timestamp}-daemon.log` : `${timestamp}.log`
  return join(resolveLogsDir(), filename)
}

async function pruneCurrentProcessLogsBestEffort(currentLogPath: string): Promise<void> {
  const logsDir = resolveLogsDir()
  if (configuration.isDaemonProcess) {
    await pruneLogsByCount({
      dir: logsDir,
      suffix: DAEMON_LOG_SUFFIX,
      keepCount: resolveDaemonLogKeepCount(),
      keepPath: currentLogPath,
    })
    return
  }

  const keepCount = resolveSessionLogKeepCount()
  await pruneLogsByCount({
    dir: logsDir,
    suffix: LOG_FILE_SUFFIX,
    excludeSuffix: DAEMON_LOG_SUFFIX,
    keepCount,
    keepPath: currentLogPath,
    keepPaths: [
      ...resolveCrashedSessionLogKeepPaths(logsDir),
      ...resolveLiveSessionLogKeepPaths(logsDir, keepCount),
    ],
  })
}

type CrashedSessionExitReportReference = Readonly<{
  pid: number;
  observedAt: number;
}>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonZeroSessionExitReport(report: Readonly<Record<string, unknown>>): boolean {
  return (typeof report.code === 'number' && report.code !== 0)
    || (typeof report.signal === 'string' && report.signal.trim().length > 0)
}

function readNonZeroSessionExitReportReference(reportPath: string): CrashedSessionExitReportReference | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (!isRecord(parsed) || !isNonZeroSessionExitReport(parsed)) return null
    const pid = typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null
    if (pid === null) return null
    const observedAt = typeof parsed.observedAt === 'number' && Number.isFinite(parsed.observedAt)
      ? parsed.observedAt
      : statSync(reportPath).mtimeMs
    return { pid, observedAt }
  } catch {
    return null
  }
}

function resolveCrashedSessionLogKeepPaths(logsDir: string): string[] {
  const keepCount = resolveCrashedSessionLogKeepCount()
  if (keepCount <= 0) return []
  try {
    const sessionExitDir = join(logsDir, 'session-exit')
    const crashedPids = new Set(
      readdirSync(sessionExitDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => readNonZeroSessionExitReportReference(join(sessionExitDir, file)))
        .filter((entry): entry is CrashedSessionExitReportReference => entry !== null)
        .sort((a, b) => b.observedAt - a.observedAt)
        .slice(0, keepCount)
        .map((entry) => entry.pid),
    )
    if (crashedPids.size === 0) return []
    return readdirSync(logsDir)
      .filter((file) => file.endsWith(LOG_FILE_SUFFIX) && !file.endsWith(DAEMON_LOG_SUFFIX))
      .filter((file) => {
        const match = /-pid-(\d+)\.log$/.exec(file)
        if (!match) return false
        return crashedPids.has(Number(match[1]))
      })
      .map((file) => join(logsDir, file))
  } catch {
    return []
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

export class Logger {
  private dangerouslyUnencryptedServerLoggingUrl: string | undefined
  private hasLoggedFileWriteError: boolean = false
  private readonly fileLogLevel: FileLogLevel
  private readonly debugFileEnabled: boolean
  private readonly infoFileEnabled: boolean
  private readonly warnFileEnabled: boolean
  private readonly fileAppender: BufferedFileAppender
  private readonly pluginInvocationFileAppender: BufferedFileAppender

  constructor(
    public readonly logFilePath = getSessionLogPath()
  ) {
    this.fileLogLevel = resolveFileLogLevel({ env: process.env, isDaemonProcess: configuration.isDaemonProcess })
    this.debugFileEnabled = isFileLogLevelEnabled(this.fileLogLevel, 'debug')
    this.infoFileEnabled = isFileLogLevelEnabled(this.fileLogLevel, 'info')
    this.warnFileEnabled = isFileLogLevelEnabled(this.fileLogLevel, 'warn')
    this.fileAppender = new BufferedFileAppender({
      filePath: this.logFilePath,
      onWriteError: (error) => this.handleFileWriteError(error),
    })
    this.pluginInvocationFileAppender = new BufferedFileAppender({
      filePath: this.logFilePath,
    })
    void pruneCurrentProcessLogsBestEffort(this.logFilePath).catch(() => {})

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
    if (!this.debugFileEnabled) return
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)

    // NOTE: @kirill does not think its a good ideas,
    // as it will break us using claude in interactive mode.
    // Instead simply open the debug file in a new editor window.
    //
    // Also log to console in development mode
    // if (process.env.DEBUG) {
    //   this.logToConsole('debug', '', message, ...args)
    // }
  }

  debugLargeJson(
    message: string,
    object: unknown,
    maxStringLength: number = 100,
    maxArrayLength: number = 10,
  ): void {
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
      
      if (isErrorLikeForLog(obj)) {
        if (visited.has(obj)) return '[Circular]'
        visited.add(obj)
        const described: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(describeErrorForLog(obj))) {
          described[key] = truncateStrings(value)
        }
        return described
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
    // Always write to debug
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

  flushSync(): void {
    this.fileAppender.flushSync()
    this.pluginInvocationFileAppender.flushSync()
    void pruneCurrentProcessLogsBestEffort(this.logFilePath).catch(() => {})
  }

  appendPluginInvocationLogRecord(record: Readonly<Record<string, unknown>>): void {
    try {
      this.pluginInvocationFileAppender.append(`${JSON.stringify(record)}\n`)
    } catch {
      // Structured plugin diagnostics must never interfere with plugin work.
    }
  }

  /**
   * Reads the active daemon's structured plugin records from the canonical log
   * file. The byte cursor advances across complete newline-delimited records.
   * If a line exceeds the bounded read window, the cursor advances through its
   * fragments and discards that line until its delimiter, so a caller can poll
   * this projection without a second store, file watcher, or retry spin.
   */
  readPluginInvocationLogRecords(query: PluginInvocationLogQuery): PluginInvocationLogReadResult {
    const limit = normalizePluginInvocationLogReadLimit(query.limit)
    const requestedCursor = normalizePluginInvocationLogReadCursor(query.cursor)
    try {
      this.pluginInvocationFileAppender.flushSync()
      const stats = statSync(this.logFilePath)
      if (!stats.isFile()) return { kind: 'unavailable' }
      const fileSize = Math.max(0, Math.trunc(stats.size))
      const startOffset = requestedCursor > fileSize ? 0 : requestedCursor
      if (startOffset === fileSize) {
        return {
          kind: 'available',
          records: Object.freeze([]),
          cursor: startOffset,
          hasMore: false,
        }
      }

      const readLength = Math.min(MAX_PLUGIN_INVOCATION_LOG_READ_BYTES, fileSize - startOffset)
      const buffer = Buffer.allocUnsafe(readLength)
      const descriptor = openSync(this.logFilePath, 'r')
      try {
        const bytesRead = readSync(descriptor, buffer, 0, buffer.length, startOffset)
        const records: PluginInvocationLogRecord[] = []
        let index = 0
        let cursor = startOffset
        const precedingByte = Buffer.allocUnsafe(1)
        let discardLeadingFragment = startOffset > 0
          && (readSync(descriptor, precedingByte, 0, 1, startOffset - 1) !== 1 || precedingByte[0] !== 0x0A)
        while (index < bytesRead) {
          const newlineIndex = buffer.indexOf(0x0A, index)
          if (newlineIndex < 0 || newlineIndex >= bytesRead) {
            // A full bounded window without a newline is an oversized generic
            // line. Advance now; the next page recognizes its mid-line cursor
            // and discards the remaining fragment before parsing another line.
            if (discardLeadingFragment || bytesRead === MAX_PLUGIN_INVOCATION_LOG_READ_BYTES) {
              cursor = startOffset + bytesRead
            }
            break
          }
          const line = buffer.subarray(index, newlineIndex)
          index = newlineIndex + 1
          cursor = startOffset + index
          if (discardLeadingFragment) {
            discardLeadingFragment = false
            continue
          }
          if (line.length === 0) continue
          try {
            const parsed: unknown = JSON.parse(line.toString('utf8'))
            if (isPluginInvocationLogRecord(parsed) && recordMatchesPluginInvocationLogQuery(parsed, query)) {
              records.push(parsed)
              if (records.length >= limit) break
            }
          } catch {
            // Generic daemon log lines and interrupted writes are not records.
          }
        }
        return {
          kind: 'available',
          records: Object.freeze(records),
          cursor,
          hasMore: cursor < fileSize,
        }
      } finally {
        closeSync(descriptor)
      }
    } catch {
      return { kind: 'unavailable' }
    }
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
              try { return JSON.stringify(a, createErrorAwareLogReplacer(), 2) } catch { return String(a) }
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
        return JSON.stringify(arg, createErrorAwareLogReplacer())
      } catch {
        // Circular references, BigInt, exotic getters, etc.
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
    
    this.fileAppender.append(logLine)
  }

  private handleFileWriteError(error: unknown): void {
    if (process.env.DEBUG && !this.hasLoggedFileWriteError) {
      writeConsoleErrorBestEffort('[DEV MODE ONLY] Failed to append to log file:', error)
      this.hasLoggedFileWriteError = true
    }
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
    const logsDir = resolveLogsDir();
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith('-daemon.log'))
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
