import { appendFile, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type {
    ExecClientDiagnosticsV1,
    ExecClientHooksV1,
    JsonRpcMessageHookDecisionV1,
} from '../privateContract';

import { safeJsonStringify } from '@/utils/safeJson';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import { PluginExecClientError } from '../errors';
import { sanitizeRpcDiagnosticValue } from './sanitize';

const DEFAULT_RPC_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RPC_LOG_ROTATE_COUNT = 2;

type JsonRpcLogMessage = Record<string, unknown>;

type JsonRpcLogEntry = Readonly<{
    direction: 'incoming' | 'outgoing';
    id?: string | number | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
}>;

export type ExecClientRpcLogger = Readonly<{
    append: (direction: 'incoming' | 'outgoing', message: unknown) => void;
    flush: () => Promise<void>;
}>;

type ExecClientRpcLoggerOptions = Readonly<{
    allowedDirectories?: readonly string[];
}>;

function readPositiveInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.trunc(value);
}

async function rotateRpcLogIfNeeded(path: string, payload: string, maxBytes: number, rotateCount: number): Promise<void> {
    if (rotateCount <= 0) {
        return;
    }
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const current = await stat(path).catch((error: unknown) => {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
            return null;
        }
        throw error;
    });
    if (!current || current.size + payloadBytes <= maxBytes) {
        return;
    }

    await rm(`${path}.${rotateCount}`, { force: true }).catch(() => undefined);
    for (let index = rotateCount - 1; index >= 1; index -= 1) {
        await rename(`${path}.${index}`, `${path}.${index + 1}`).catch((error: unknown) => {
            if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
                return;
            }
            throw error;
        });
    }
    await rename(path, `${path}.1`).catch((error: unknown) => {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
            return;
        }
        throw error;
    });
}

function assertRpcLogPathAllowed(path: string, options: ExecClientRpcLoggerOptions | undefined): void {
    const allowedDirectories = options?.allowedDirectories ?? [];
    if (!isAbsolute(path)) {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            'ctx.exec.spawnClient diagnostics rpcLog.path must be an absolute host-approved file path',
        );
    }
    if (!allowedDirectories.some((directory) => isCanonicalAbsolutePathInsideRoot(directory, path))) {
        throw new PluginExecClientError(
            'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            'ctx.exec.spawnClient diagnostics rpcLog.path is outside the host-approved diagnostics directories',
        );
    }
}

function isJsonRpcLogMessage(value: unknown): value is JsonRpcLogMessage {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonRpcLogId(value: unknown): string | number | null | undefined {
    return typeof value === 'string' || typeof value === 'number' || value === null ? value : undefined;
}

function toJsonRpcLogEntry(
    direction: 'incoming' | 'outgoing',
    message: unknown,
    diagnostics: ExecClientDiagnosticsV1,
): JsonRpcLogEntry {
    if (!isJsonRpcLogMessage(message)) {
        return Object.freeze({
            direction,
            params: sanitizeRpcDiagnosticValue(message, diagnostics.sanitizer),
        });
    }
    return Object.freeze({
        direction,
        ...(readJsonRpcLogId(message.id) !== undefined ? { id: readJsonRpcLogId(message.id) } : {}),
        ...(typeof message.method === 'string' ? { method: message.method } : {}),
        ...('params' in message ? { params: sanitizeRpcDiagnosticValue(message.params, diagnostics.sanitizer) } : {}),
        ...('result' in message ? { result: sanitizeRpcDiagnosticValue(message.result, diagnostics.sanitizer) } : {}),
        ...('error' in message ? { error: sanitizeRpcDiagnosticValue(message.error, diagnostics.sanitizer) } : {}),
    });
}

function createNoopRpcLogger(): ExecClientRpcLogger {
    return Object.freeze({
        append: () => undefined,
        flush: async () => undefined,
    });
}

export function createExecClientRpcLogger(
    diagnostics: ExecClientDiagnosticsV1 | undefined,
    options?: ExecClientRpcLoggerOptions,
): ExecClientRpcLogger {
    const rpcLog = diagnostics?.rpcLog;
    if (!rpcLog) {
        return createNoopRpcLogger();
    }
    assertRpcLogPathAllowed(rpcLog.path, options);
    const maxBytes = readPositiveInteger(rpcLog.maxBytes, DEFAULT_RPC_LOG_MAX_BYTES);
    const rotateCount = Math.min(readPositiveInteger(rpcLog.rotateCount, DEFAULT_RPC_LOG_ROTATE_COUNT), 10);
    let chain = Promise.resolve();

    return Object.freeze({
        append(direction, message) {
            const entry = toJsonRpcLogEntry(direction, message, diagnostics);
            const payload = `${safeJsonStringify(entry)}\n`;
            chain = chain
                .then(async () => {
                    await rotateRpcLogIfNeeded(rpcLog.path, payload, maxBytes, rotateCount);
                    await appendFile(rpcLog.path, payload, { encoding: 'utf8' });
                })
                .catch(() => undefined);
        },
        async flush() {
            await chain;
        },
    });
}

function normalizeHookDecision(
    decision: JsonRpcMessageHookDecisionV1 | undefined,
    originalMessage: unknown,
): unknown | null {
    if (decision === undefined || decision === 'pass') {
        return originalMessage;
    }
    if (decision === 'suppress') {
        return null;
    }
    return decision.message;
}

export function composeJsonRpcDiagnosticHooks(
    hooks: ExecClientHooksV1['jsonRpc'] | undefined,
    logger: ExecClientRpcLogger,
): ExecClientHooksV1['jsonRpc'] | undefined {
    if (!hooks?.onMessage) {
        return {
            onMessage: (message, context) => {
                logger.append(context.phase, message);
                return 'pass';
            },
        };
    }
    return {
        async onMessage(message, context) {
            const decision = await hooks.onMessage?.(message, context);
            const loggedMessage = normalizeHookDecision(decision, message);
            if (loggedMessage !== null) {
                logger.append(context.phase, loggedMessage);
            }
            return decision ?? 'pass';
        },
    };
}
