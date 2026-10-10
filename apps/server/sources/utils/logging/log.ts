import pino from 'pino';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { redactHttpRequestUrlForLog } from './redactHttpRequestUrlForLog';

// Single log file name created once at startup
let consolidatedLogFile: string | undefined;

function prepareConsolidatedLogFile(env: NodeJS.ProcessEnv): void {
  if (!env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING || consolidatedLogFile) return;
  const logsDir = join(process.cwd(), '.logs');
  try {
    mkdirSync(logsDir, { recursive: true });
    // Create filename once at startup
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    consolidatedLogFile = join(
      logsDir,
      `${month}-${day}-${hour}-${min}-${sec}.log`,
    );
    console.log(
      `[PINO] Remote debugging logs enabled - writing to ${consolidatedLogFile}`,
    );
  } catch (error) {
    console.error('Failed to create logs directory:', error);
  }
}

// Format time as HH:MM:ss.mmm in local time
function formatLocalTime(timestamp?: number) {
  const date = timestamp ? new Date(timestamp) : new Date();
  const hours = String(date.getHours()).padStart(2, '0');
  const mins = String(date.getMinutes()).padStart(2, '0');
  const secs = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}:${mins}:${secs}.${ms}`;
}

function isBunRuntime() {
  const g = globalThis as any;
  return Boolean(g?.Bun) || Boolean((process as any)?.versions?.bun);
}

export function resolveServerLogLevelFromEnv(
  env: NodeJS.ProcessEnv,
): pino.LevelWithSilent {
  const raw = (
    env.HAPPIER_SERVER_LOG_LEVEL ??
    env.HAPPIER_LOG_LEVEL ??
    env.LOG_LEVEL ??
    ''
  )
    .trim()
    .toLowerCase();
  const allowed = new Set<pino.LevelWithSilent>([
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent',
  ]);
  return allowed.has(raw as pino.LevelWithSilent)
    ? (raw as pino.LevelWithSilent)
    : 'info';
}

export function createLoggingTransportTargets(env: NodeJS.ProcessEnv = process.env): pino.TransportTargetOptions[] {
  const transports: pino.TransportTargetOptions[] = [];

  // Bun-compiled binaries can't reliably resolve pino transport targets.
  if (!isBunRuntime()) {
    transports.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{levelLabel} {msg} | [{time}]',
        errorLikeObjectKeys: ['err', 'error'],
      },
    });
  }

  if (
    env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING &&
    consolidatedLogFile
  ) {
    transports.push({
      target: 'pino/file',
      options: {
        destination: consolidatedLogFile,
        mkdir: true,
        messageFormat: '{levelLabel} {msg} | [server time: {time}]',
      },
    });
  }

  return transports;
}

export function serializeHttpRequestForLog(request: {
  method?: unknown;
  url?: unknown;
  headers?: { host?: unknown } | undefined;
  hostname?: unknown;
  socket?: { remoteAddress?: unknown; remotePort?: unknown } | undefined;
}): Record<string, unknown> {
  const url = typeof request.url === 'string' ? request.url : '';
  return {
    method: typeof request.method === 'string' ? request.method : undefined,
    url: redactHttpRequestUrlForLog(url),
    host:
      typeof request.headers?.host === 'string'
        ? request.headers.host
        : typeof request.hostname === 'string'
          ? request.hostname
          : undefined,
    remoteAddress:
      typeof request.socket?.remoteAddress === 'string'
        ? request.socket.remoteAddress
        : undefined,
    remotePort:
      typeof request.socket?.remotePort === 'number'
        ? request.socket.remotePort
        : undefined,
  };
}

function createServerLogger(
  env: NodeJS.ProcessEnv,
  transportTargets: pino.TransportTargetOptions[] = [],
): pino.Logger {
  return pino({
    level: resolveServerLogLevelFromEnv(env),
    ...(transportTargets.length ? { transport: { targets: transportTargets } } : {}),
    formatters: {
      log: (object: Record<string, unknown>) => ({
        ...object,
        localTime: formatLocalTime(typeof object.time === 'number' ? object.time : undefined),
      }),
    },
    serializers: { req: serializeHttpRequestForLog },
    timestamp: () => `,"time":${Date.now()},"localTime":"${formatLocalTime()}"`,
  });
}

// Bootstrap output needs no transport workers. Startup config owns the final loggers.
export let logger = createServerLogger(process.env);
export let fileConsolidatedLogger: pino.Logger | undefined;

/** Called once at the startup composition's post-Home-overlay boundary. */
export function initializeServerLogging(env: NodeJS.ProcessEnv): void {
  prepareConsolidatedLogFile(env);
  logger = createServerLogger(env, createLoggingTransportTargets(env));
  fileConsolidatedLogger = env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && consolidatedLogFile
    ? createServerLogger(env, [{ target: 'pino/file', options: { destination: consolidatedLogFile, mkdir: true } }])
    : undefined;
}

const ENTRY_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
]);

/** Emits at the entry's own `level` field when it names a pino level, otherwise at info. */
export function log(src: any, ...args: any[]) {
  const level =
    src &&
    typeof src === 'object' &&
    typeof src.level === 'string' &&
    ENTRY_LEVELS.has(src.level)
      ? (src.level as 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace')
      : 'info';
  logger[level](src, ...args);
}

export function warn(src: any, ...args: any[]) {
  logger.warn(src, ...args);
}

export function error(src: any, ...args: any[]) {
  logger.error(src, ...args);
}

export function debug(src: any, ...args: any[]) {
  logger.debug(src, ...args);
}
