import { createHash } from 'node:crypto';

import {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';
import type { JsonValue, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { PluginLoggerService } from '@happier-dev/plugin-sdk/runtime';

import type { PluginInvocationServicesSeed } from './types';

export const PLUGIN_LOG_MAX_RECORD_BYTES = 32 * 1024;
export const PLUGIN_LOG_MAX_MESSAGE_BYTES = 4 * 1024;
export const PLUGIN_LOG_MAX_VALUE_BYTES = 4 * 1024;
export const PLUGIN_LOG_MAX_CONTEXT_VALUE_BYTES = 2 * 1024;
export const PLUGIN_LOG_MAX_DEPTH = 8;
export const PLUGIN_LOG_MAX_COLLECTION_ENTRIES = 64;
export const PLUGIN_LOG_MAX_NODES = 256;

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[TRUNCATED]';
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passphrase|private[-_]?key|secret|session(?:id)?|token|jwt|api[-_]?key)/iu;
const HTTP_URL = /https?:\/\/[^\s"'<>]+/giu;

export type PluginInvocationLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'diagnostic';

export type PluginInvocationLogRecord = Readonly<{
    version: 1;
    kind: 'plugin_invocation_log';
    level: PluginInvocationLogLevel;
    message?: string;
    fields?: Readonly<Record<string, JsonValue>>;
    diagnostic?: Readonly<Record<string, JsonValue>>;
    context: Readonly<{
        plugin: Readonly<{ id: string; version: string }>;
        contribution: Readonly<{ id: string; qualifiedId: string }>;
        generation: string;
        correlationId: string;
        surface: PluginInvocationServicesSeed['surface'];
        sessionId?: string;
    }>;
    occurredAtMs: number;
    sequence: number;
}>;

export type PluginInvocationLogSink = Readonly<{
    write(record: PluginInvocationLogRecord): void;
}>;

export type PluginInvocationSecretRedactionScope = Readonly<{
    pluginId: string;
    generation: string;
}>;

export type PluginInvocationSecretRedactor = Readonly<{
    register(scope: PluginInvocationSecretRedactionScope, value: string): void;
    redact(scope: PluginInvocationSecretRedactionScope, value: string): string;
    retireGeneration(generation: string, pluginId: string): void;
}>;

function secretRedactionScopeKey(scope: PluginInvocationSecretRedactionScope): string {
    return `${scope.generation}\u0000${scope.pluginId}`;
}

export function createPluginInvocationSecretRedactor(): PluginInvocationSecretRedactor {
    const valuesByScope = new Map<string, Set<string>>();
    return Object.freeze({
        register(scope, value): void {
            if (value.length === 0) return;
            const key = secretRedactionScopeKey(scope);
            let values = valuesByScope.get(key);
            if (!values) {
                values = new Set();
                valuesByScope.set(key, values);
            }
            values.add(value);
        },
        redact(scope, value): string {
            const values = valuesByScope.get(secretRedactionScopeKey(scope));
            if (!values || values.size === 0) return value;
            let redacted = value;
            for (const secret of [...values].sort((left, right) => right.length - left.length)) {
                redacted = redacted.split(secret).join(REDACTED);
            }
            return redacted;
        },
        retireGeneration(generation, pluginId): void {
            valuesByScope.delete(secretRedactionScopeKey({ generation, pluginId }));
        },
    });
}

type SanitizeState = {
    readonly visited: WeakSet<object>;
    nodes: number;
};

function truncateRedactedText(value: string, maxBytes: number, redact?: (value: string) => string): string {
    const secretsRedacted = redact?.(value) ?? value;
    const urlsRedacted = secretsRedacted.replace(HTTP_URL, (rawUrl) => {
        try {
            const url = new URL(rawUrl);
            let redacted = false;
            if (url.username || url.password) {
                url.username = '';
                url.password = '';
                redacted = true;
            }
            const sensitiveQueryKeys = [...url.searchParams.keys()]
                .filter((key) => SENSITIVE_KEY.test(key));
            for (const key of sensitiveQueryKeys) url.searchParams.delete(key);
            if (sensitiveQueryKeys.length > 0) redacted = true;
            if (redacted) url.searchParams.append('_redacted', REDACTED);
            return url.toString();
        } catch {
            return rawUrl;
        }
    });
    const redacted = redactBugReportSensitiveText(urlsRedacted);
    if (Buffer.byteLength(redacted, 'utf8') <= maxBytes) return redacted;
    const markerBytes = Buffer.byteLength(TRUNCATED, 'utf8');
    return `${trimBugReportTextToMaxBytes(redacted, Math.max(0, maxBytes - markerBytes))}${TRUNCATED}`;
}

function boundHostIdentity(value: string): string {
    if (Buffer.byteLength(value, 'utf8') <= PLUGIN_LOG_MAX_CONTEXT_VALUE_BYTES) {
        return truncateRedactedText(value, PLUGIN_LOG_MAX_CONTEXT_VALUE_BYTES);
    }
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sanitizeValue(
    value: unknown,
    state: SanitizeState,
    depth: number,
    key?: string,
    redact?: (value: string) => string,
): JsonValue {
    if (key && SENSITIVE_KEY.test(key)) return REDACTED;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return truncateRedactedText(value, PLUGIN_LOG_MAX_VALUE_BYTES, redact);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return truncateRedactedText(value.toString(), PLUGIN_LOG_MAX_VALUE_BYTES);
    if (typeof value !== 'object') return `[Unsupported:${typeof value}]`;
    if (depth >= PLUGIN_LOG_MAX_DEPTH || state.nodes >= PLUGIN_LOG_MAX_NODES) return TRUNCATED;
    if (state.visited.has(value)) return CIRCULAR;
    state.visited.add(value);
    state.nodes += 1;
    if (Array.isArray(value)) {
        const items = value.slice(0, PLUGIN_LOG_MAX_COLLECTION_ENTRIES)
        .map((item) => sanitizeValue(item, state, depth + 1, undefined, redact));
        if (value.length > PLUGIN_LOG_MAX_COLLECTION_ENTRIES) items.push(TRUNCATED);
        return items;
    }
    const output: Record<string, JsonValue> = {};
    let entries: [string, unknown][];
    try {
        entries = Object.entries(value);
    } catch {
        return '[Unsupported:object]';
    }
    for (const [entryKey, entryValue] of entries.slice(0, PLUGIN_LOG_MAX_COLLECTION_ENTRIES)) {
        output[truncateRedactedText(entryKey, 256, redact)] = sanitizeValue(entryValue, state, depth + 1, entryKey, redact);
    }
    if (entries.length > PLUGIN_LOG_MAX_COLLECTION_ENTRIES) output._truncated = TRUNCATED;
    return output;
}

function sanitizeRecord(value: unknown, redact?: (value: string) => string): Readonly<Record<string, JsonValue>> {
    const sanitized = sanitizeValue(value, { visited: new WeakSet(), nodes: 0 }, 0, undefined, redact);
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
        return Object.freeze({ _value: sanitized });
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(sanitized)) output[key] = value;
    return Object.freeze(output);
}

function sanitizeDiagnostic(
    data: PluginDiagnosticData,
    redact?: (value: string) => string,
): Readonly<Record<string, JsonValue>> {
    const candidate = {
        code: data.code,
        severity: data.severity,
        ...(data.message === undefined ? {} : { message: data.message }),
        ...(data.details === undefined ? {} : { details: data.details }),
        ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
    };
    return sanitizeRecord(candidate, redact);
}

function byteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function freezeRecord(record: PluginInvocationLogRecord): PluginInvocationLogRecord {
    if (record.fields) Object.freeze(record.fields);
    if (record.diagnostic) Object.freeze(record.diagnostic);
    Object.freeze(record.context.plugin);
    Object.freeze(record.context.contribution);
    Object.freeze(record.context);
    return Object.freeze(record);
}

function boundRecord(record: PluginInvocationLogRecord): PluginInvocationLogRecord {
    if (byteLength(record) <= PLUGIN_LOG_MAX_RECORD_BYTES) return freezeRecord(record);
    const bounded: PluginInvocationLogRecord = {
        ...record,
        ...(record.message === undefined ? {} : { message: truncateRedactedText(record.message, 1024) }),
        ...(record.fields === undefined ? {} : { fields: Object.freeze({ _truncated: TRUNCATED }) }),
        ...(record.diagnostic === undefined
            ? {}
            : {
                diagnostic: Object.freeze({
                    code: record.diagnostic.code ?? 'plugin_diagnostic_truncated',
                    severity: record.diagnostic.severity ?? 'error',
                    message: TRUNCATED,
                }),
            }),
    };
    return freezeRecord(bounded);
}

export function createPluginInvocationLogger(params: Readonly<{
    seed: PluginInvocationServicesSeed;
    sink: PluginInvocationLogSink;
    now?: () => number;
    secretRedactor?: PluginInvocationSecretRedactor;
}>): PluginLoggerService {
    let sequence = 0;
    const context = Object.freeze({
        plugin: Object.freeze({
            id: boundHostIdentity(params.seed.plugin.id),
            version: boundHostIdentity(params.seed.plugin.version),
        }),
        contribution: Object.freeze({
            id: boundHostIdentity(params.seed.contribution.id),
            qualifiedId: boundHostIdentity(params.seed.contribution.qualifiedId),
        }),
        generation: boundHostIdentity(params.seed.generation),
        correlationId: boundHostIdentity(params.seed.correlationId),
        surface: params.seed.surface,
    });
    const redactionScope = Object.freeze({
        pluginId: params.seed.plugin.id,
        generation: params.seed.generation,
    });
    const redact = params.secretRedactor
        ? (value: string): string => params.secretRedactor!.redact(redactionScope, value)
        : undefined;
    const emit = (
        level: PluginInvocationLogLevel,
        input: Readonly<{ message?: string; fields?: Readonly<Record<string, JsonValue>>; diagnostic?: PluginDiagnosticData }>,
    ): void => {
        try {
            if (params.seed.signal.aborted || !params.seed.isGenerationCurrent()) return;
            const message = input.message === undefined
                ? undefined
                : truncateRedactedText(input.message, PLUGIN_LOG_MAX_MESSAGE_BYTES, redact);
            const fields = input.fields === undefined ? undefined : sanitizeRecord(input.fields, redact);
            const diagnostic = input.diagnostic === undefined ? undefined : sanitizeDiagnostic(input.diagnostic, redact);
            if (params.seed.signal.aborted || !params.seed.isGenerationCurrent()) return;
            const nextSequence = sequence + 1;
            const record = boundRecord({
                version: 1,
                kind: 'plugin_invocation_log',
                level,
                ...(message === undefined ? {} : { message }),
                ...(fields === undefined ? {} : { fields }),
                ...(diagnostic === undefined ? {} : { diagnostic }),
                context,
                occurredAtMs: params.now?.() ?? Date.now(),
                sequence: nextSequence,
            });
            if (params.seed.signal.aborted || !params.seed.isGenerationCurrent()) return;
            sequence = nextSequence;
            params.sink.write(record);
        } catch {
            // Diagnostics are strictly failure-isolated from plugin work.
        }
    };
    const log = (level: Exclude<PluginInvocationLogLevel, 'diagnostic'>) => (
        message: string,
        fields?: Readonly<Record<string, JsonValue>>,
    ): void => emit(level, { message, ...(fields === undefined ? {} : { fields }) });
    return Object.freeze({
        debug: log('debug'),
        info: log('info'),
        warn: log('warn'),
        error: log('error'),
        diagnostic: (data: PluginDiagnosticData) => emit('diagnostic', { diagnostic: data }),
    });
}
