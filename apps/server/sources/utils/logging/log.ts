import pino from 'pino';
import { createHash } from 'node:crypto';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { redactHttpRequestUrlForLog } from './redactHttpRequestUrlForLog';
import { isBunRuntime } from '../runtime/isBunRuntime';

// Single log file name created once at startup
let consolidatedLogFile: string | undefined;

function prepareConsolidatedLogFile(env: NodeJS.ProcessEnv): void {
  if (!readServerConfig(env, SERVER_CONFIG.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) || consolidatedLogFile) return;
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
    console.error(
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

/**
 * An explicit setting (Home or env) wins. Otherwise a production runtime (the Docker images set
 * NODE_ENV=production) writes JSON with no worker thread, and development (source, stacks) stays pretty.
 */
export function resolveServerLogFormat(env: NodeJS.ProcessEnv): 'pretty' | 'json' {
  return readServerConfig(env, SERVER_CONFIG.HAPPIER_SERVER_LOG_FORMAT)
    ?? (readServerConfig(env, SERVER_CONFIG.NODE_ENV) === 'production' ? 'json' : 'pretty');
}

export function createLoggingTransportTargets(env: NodeJS.ProcessEnv = process.env): pino.TransportTargetOptions[] {
  const transports: pino.TransportTargetOptions[] = [];

  // Bun-compiled binaries can't reliably resolve pino transport targets.
  if (!isBunRuntime() && resolveServerLogFormat(env) === 'pretty') {
    transports.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{levelLabel} {msg} | [{time}]',
        errorLikeObjectKeys: ['err', 'error'],
        // Keep all request/diagnostic fields; pino-pretty still expands error stacks.
        singleLine: true,
      },
    });
  }

  if (
    readServerConfig(env, SERVER_CONFIG.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) &&
    consolidatedLogFile
  ) {
    // Preserve the single JSON destination's level when adding a second output.
    const fileLevel = transports.length === 0 ? 'trace' : undefined;
    // A file transport replaces Pino's default stdout destination. Keep both outputs.
    if (transports.length === 0) {
      transports.push({ target: 'pino/file', level: 'trace', options: { destination: 1 } });
    }
    transports.push({
      target: 'pino/file',
      level: fileLevel,
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

/**
 * Privacy projection for Fastify's existing completion/error response records.
 * Never serialize the reply/request, headers, principal or response payload.
 */
function serializeHttpResponseForLog(reply: Pick<import('fastify').FastifyReply, 'statusCode'> & {
  request?: import('fastify').FastifyRequest;
}): Record<string, unknown> {
  const request = reply.request;
  const kind = request?.authTokenKind;
  const authTokenKind = kind === 'account' || kind === 'account_directory'
    || kind === 'terminal' || kind === 'api_token' || kind === 'ephemeral_session_runner'
    ? kind : 'unknown';
  const authority = request?.authAuthority;
  const rawPurpose = request?.headers['x-happier-request-purpose'];
  return {
    statusCode: reply.statusCode,
    accountAlias: authTokenKind !== 'unknown' && typeof request?.userId === 'string' && request.userId.length > 0
      ? `acct_${createHash('sha256').update(request.userId).digest('hex').slice(0, 12)}`
      : 'unknown',
    // HTTP credential provenance does not distinguish UI, CLI, daemon or plugin.
    clientKind: 'unknown',
    authTokenKind,
    authAuthority: authority === 'present_user' || authority === 'account_automation' ? authority : 'unknown',
    // This existing CLI telemetry is caller-declared, never authorization.
    // Only known non-content labels leave the header boundary.
    requestPurpose: rawPurpose === undefined ? 'unknown'
      : typeof rawPurpose === 'string' && HTTP_REQUEST_LOG_PURPOSES.has(rawPurpose) ? rawPurpose : 'unrecognized',
    ...(request?.followSourceRoute ? { followSourceRoute: {
      resultCode: request.followSourceRoute.resultCode,
      ...(request.followSourceRoute.sourceKind ? { sourceKind: request.followSourceRoute.sourceKind } : {}),
      ...(request.followSourceRoute.sourceSessionId ? { sourceSessionId: request.followSourceRoute.sourceSessionId } : {}),
      ...(request.followSourceRoute.sourceRunId ? { sourceRunId: request.followSourceRoute.sourceRunId } : {}),
      ...(request.followSourceRoute.sourceMachineId ? { sourceMachineId: request.followSourceRoute.sourceMachineId } : {}),
      ...(request.followSourceRoute.sourceTargetMachineId ? { sourceTargetMachineId: request.followSourceRoute.sourceTargetMachineId } : {}),
      ...(request.followSourceRoute.releaseReason ? { releaseReason: request.followSourceRoute.releaseReason } : {}),
      ...(request.followSourceRoute.sourceRpcCode ? { sourceRpcCode: request.followSourceRoute.sourceRpcCode } : {}),
      ...(request.followSourceRoute.sourceDiscussionId ? { sourceDiscussionId: request.followSourceRoute.sourceDiscussionId } : {}),
      ...(request.followSourceRoute.sourceReadCode ? { sourceReadCode: request.followSourceRoute.sourceReadCode } : {}),
    } } : {}),
  };
}

// Logging allowlist for existing producers in api/session/sessionSnapshotRefreshReason.ts
// deliverSessionEndMutation.ts, sessionFollowInactiveObservationsHttp.ts and
// api/client/qualifiedConnectedAccountApi.ts (CLI).
// This does not introduce a header protocol.
const HTTP_REQUEST_LOG_PURPOSES = new Set([
  'connected-accounts:qualification',
  'connected-accounts:daemon-coordinator',
  'connected-accounts:requester-coordinator',
  'connected-accounts:requester-qualification',
  'connected-accounts:purpose-binding',
  'connected-accounts:startup-hydration',
  'connected-accounts:quota-qualification',
  'connected-accounts:usage-persistence',
  'connected-accounts:request-auth-replacement',
  'connected-accounts:auth-group',
  'connected-accounts:team-reconciliation',
  'connected-accounts:spawn',
  'connected-accounts:persistence',
  'session-follow:receiver-recovery',
  'session-follow:manager-turn-admission',
  'session-detail:socket-connect-catchup',
  'session-detail:socket-reconnect-catchup',
  'session-detail:metadata-wait-catchup',
  'session-detail:primary-turn-runtime-state',
  'session-detail:degraded-socket-repair',
  'session-detail:explicit-drain',
  'session-detail:startup-drain',
  'session-detail:manual-recovery',
  'session-detail:legacy-compat-proof',
  'session-detail:follow-occurrence',
  'session-detail:follow-source-hydration',
  'session-detail:requester-binding',
  'session-detail:memory-change',
  'session-detail:close-end-proof',
  'session-detail:session-query',
  'session-detail:session-control',
  'session-detail:session-replay',
  'session-detail:session-action',
  'session-detail:session-notification',
  'session-detail:session-content',
  'session-detail:usage-query',
]);

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
    serializers: { req: serializeHttpRequestForLog, res: serializeHttpResponseForLog, error: pino.stdSerializers.err },
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
  fileConsolidatedLogger = readServerConfig(env, SERVER_CONFIG.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) && consolidatedLogFile
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
