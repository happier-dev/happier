import pino from 'pino';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol';
import { isBunRuntime } from '../runtime/isBunRuntime';

// Single log file name created once at startup
let consolidatedLogFile: string | undefined;

if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
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
        consolidatedLogFile = join(logsDir, `${month}-${day}-${hour}-${min}-${sec}.log`);
        console.error(`[PINO] Remote debugging logs enabled - writing to ${consolidatedLogFile}`);
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

export function resolveServerLogLevelFromEnv(env: NodeJS.ProcessEnv): pino.LevelWithSilent {
    const raw = (
        env.HAPPIER_SERVER_LOG_LEVEL
        ?? env.HAPPIER_LOG_LEVEL
        ?? env.LOG_LEVEL
        ?? ""
    ).trim().toLowerCase();
    const allowed = new Set<pino.LevelWithSilent>(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
    return allowed.has(raw as pino.LevelWithSilent) ? (raw as pino.LevelWithSilent) : "info";
}

type ServerLogFormat = 'pretty' | 'json';

function resolveServerLogFormatFromEnv(env: NodeJS.ProcessEnv): ServerLogFormat {
    const raw = (env.HAPPIER_SERVER_LOG_FORMAT ?? '').trim().toLowerCase();
    return raw === 'json' ? 'json' : 'pretty';
}

export function createLoggingTransportTargets(env: NodeJS.ProcessEnv = process.env): pino.TransportTargetOptions[] {
    const transports: pino.TransportTargetOptions[] = [];

    // Bun-compiled binaries can't reliably resolve pino transport targets.
    // The json format writes pino's line-delimited JSON straight to stdout for log collectors.
    if (!isBunRuntime() && resolveServerLogFormatFromEnv(env) === 'pretty') {
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

    if (env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && consolidatedLogFile) {
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
    const host = typeof request.headers?.host === 'string'
        ? request.headers.host
        : typeof request.hostname === 'string'
            ? request.hostname
            : undefined;
    return {
        method: typeof request.method === 'string' ? request.method : undefined,
        url: redactPublicShareCapabilityUrl(url),
        host,
        remoteAddress: typeof request.socket?.remoteAddress === 'string' ? request.socket.remoteAddress : undefined,
        remotePort: typeof request.socket?.remotePort === 'number' ? request.socket.remotePort : undefined,
    };
}

// Main server logger with local time formatting
const transportTargets = createLoggingTransportTargets();
export const logger = pino({
    level: resolveServerLogLevelFromEnv(process.env),
    ...(transportTargets.length
        ? {
            transport: {
                targets: transportTargets,
            },
        }
        : {}),
    formatters: {
        log: (object: any) => {
            // Add localTime to every log entry
            return {
                ...object,
                localTime: formatLocalTime(typeof object.time === 'number' ? object.time : undefined),
            };
        }
    },
    serializers: {
        req: serializeHttpRequestForLog,
        error: pino.stdSerializers.err,
    },
    timestamp: () => `,"time":${Date.now()},"localTime":"${formatLocalTime()}"`,
});

// Optional file-only logger for remote logs from CLI/mobile
export const fileConsolidatedLogger = process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && consolidatedLogFile ?
    pino({
        level: resolveServerLogLevelFromEnv(process.env),
        transport: {
            targets: [{
                target: 'pino/file',
                options: {
                    destination: consolidatedLogFile,
                    mkdir: true,
                },
            }],
        },
        formatters: {
            log: (object: any) => {
                // Add localTime to every log entry
                // Note: source property already exists from CLI/mobile logs
                return {
                    ...object,
                    localTime: formatLocalTime(typeof object.time === 'number' ? object.time : undefined),
                };
            }
        },
        timestamp: () => `,"time":${Date.now()},"localTime":"${formatLocalTime()}"`,
    }) : undefined;

export function log(src: any, ...args: any[]) {
    logger.info(src, ...args);
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
