import { createHash } from 'node:crypto';

import {
    createSensitiveDiagnosticTextRedactor,
    redactBugReportSensitiveText,
    trimBugReportTextHeadToMaxBytes,
    type SensitiveDiagnosticTextRedactor,
    type SensitiveDiagnosticValuesLease,
} from '@happier-dev/protocol/bugs/reports';
import {
    isBaseCredentialDiagnosticKey,
    splitSensitiveDiagnosticKeySegments,
} from '@happier-dev/protocol/diagnostics/sensitive-keys';
import { PluginInvocationLogRecordV1Schema } from '@happier-dev/protocol/daemon/plugin-invocation-logs';
import type { JsonValue, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { LoggerService as PluginLoggerService } from '@happier-dev/plugin-sdk';

import type { PluginInvocationServicesSeed } from './types';

export const PLUGIN_LOG_MAX_RECORD_BYTES = 32 * 1024;
export const PLUGIN_LOG_MAX_MESSAGE_BYTES = 4 * 1024;
export const PLUGIN_LOG_MAX_VALUE_BYTES = 4 * 1024;
export const PLUGIN_LOG_MAX_CONTEXT_VALUE_BYTES = 2 * 1024;
export const PLUGIN_LOG_MAX_DEPTH = 8;
export const PLUGIN_LOG_MAX_COLLECTION_ENTRIES = 64;
export const PLUGIN_LOG_MAX_NODES = 256;
export const PLUGIN_LOG_MAX_SECRET_COMPONENT_BYTES = 16 * 1024;
export const PLUGIN_LOG_MAX_SECRET_COMPONENTS_PER_SCOPE = 128;
export const PLUGIN_LOG_MAX_SECRET_COMPONENT_TOTAL_BYTES = 256 * 1024;

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[TRUNCATED]';
const PLUGIN_LOG_CREDENTIAL_SEGMENTS = new Set([
    'auth',
    'authentication',
    'credential',
    'credentials',
    'secret',
]);
const PLUGIN_LOG_CREDENTIAL_SUFFIXES = new Set(['token']);

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

/**
 * The daemon-log reader admits only records produced by this structured logger.
 * It intentionally checks identity fields rather than matching log text.
 */
export function isPluginInvocationLogRecord(value: unknown): value is PluginInvocationLogRecord {
    return PluginInvocationLogRecordV1Schema.safeParse(value).success;
}

export type PluginInvocationLogSink = Readonly<{
    write(record: PluginInvocationLogRecord): void;
}>;

export type PluginInvocationSecretRedactionScope = Readonly<{
    pluginId: string;
    generation: string;
    correlationId: string;
}>;

export type PluginInvocationSecretRedactor = Readonly<{
    beginInvocation(scope: PluginInvocationSecretRedactionScope, signal: AbortSignal): void;
    registerRaw(scope: PluginInvocationSecretRedactionScope, value: string): void;
    registerExact(scope: PluginInvocationSecretRedactionScope, value: string): void;
    redact(scope: PluginInvocationSecretRedactionScope, value: string): string;
    completeInvocation(scope: PluginInvocationSecretRedactionScope): void;
    retireGeneration(generation: string, pluginId: string): void;
}>;

function secretRedactionScopeKey(scope: PluginInvocationSecretRedactionScope): string {
    return `${scope.generation}\u0000${scope.pluginId}\u0000${scope.correlationId}`;
}

type PluginInvocationSecretRedactionState = {
    readonly scope: PluginInvocationSecretRedactionScope;
    readonly redactor: SensitiveDiagnosticTextRedactor;
    readonly values: Set<string>;
    readonly leases: SensitiveDiagnosticValuesLease[];
    disposeSignal?: () => void;
    totalBytes: number;
    saturated: boolean;
};

export function createPluginInvocationSecretRedactor(): PluginInvocationSecretRedactor {
    const statesByScope = new Map<string, PluginInvocationSecretRedactionState>();
    const baselineRedactor = createSensitiveDiagnosticTextRedactor();
    const completeInvocation = (scope: PluginInvocationSecretRedactionScope): void => {
        const key = secretRedactionScopeKey(scope);
        const state = statesByScope.get(key);
        if (!state) return;
        statesByScope.delete(key);
        state.disposeSignal?.();
        for (const lease of state.leases.reverse()) lease.close();
    };
    const ensureState = (
        scope: PluginInvocationSecretRedactionScope,
    ): PluginInvocationSecretRedactionState => {
        const key = secretRedactionScopeKey(scope);
        let state = statesByScope.get(key);
        if (!state) {
            state = {
                scope: Object.freeze({ ...scope }),
                redactor: createSensitiveDiagnosticTextRedactor(),
                values: new Set(),
                leases: [],
                totalBytes: 0,
                saturated: false,
            };
            statesByScope.set(key, state);
        }
        return state;
    };
    const registerExact = (
        scope: PluginInvocationSecretRedactionScope,
        value: string,
    ): void => {
        if (value.length === 0) return;
        const state = statesByScope.get(secretRedactionScopeKey(scope));
        if (!state || state.saturated || state.values.has(value)) return;
        const valueBytes = Buffer.byteLength(value, 'utf8');
        if (
            valueBytes > PLUGIN_LOG_MAX_SECRET_COMPONENT_BYTES
            || state.values.size >= PLUGIN_LOG_MAX_SECRET_COMPONENTS_PER_SCOPE
            || state.totalBytes + valueBytes > PLUGIN_LOG_MAX_SECRET_COMPONENT_TOTAL_BYTES
        ) {
            state.saturated = true;
            return;
        }
        try {
            state.leases.push(state.redactor.register([value]));
            state.values.add(value);
            state.totalBytes += valueBytes;
        } catch {
            state.saturated = true;
        }
    };
    return Object.freeze({
        beginInvocation(scope, signal): void {
            const state = ensureState(scope);
            if (state.disposeSignal) return;
            const complete = () => completeInvocation(scope);
            signal.addEventListener('abort', complete, { once: true });
            state.disposeSignal = () => signal.removeEventListener('abort', complete);
            if (signal.aborted) completeInvocation(scope);
        },
        registerRaw(scope, value): void {
            if (value.length === 0) return;
            registerExact(scope, value);
            if (Buffer.byteLength(value, 'utf8') > PLUGIN_LOG_MAX_SECRET_COMPONENT_BYTES) {
                return;
            }
            const bytes = Buffer.from(value, 'utf8');
            registerExact(scope, bytes.toString('base64'));
            registerExact(scope, bytes.toString('base64url'));
            registerExact(scope, bytes.toString('hex'));
        },
        registerExact,
        redact(scope, value): string {
            const state = statesByScope.get(secretRedactionScopeKey(scope));
            if (!state) return baselineRedactor.redact(value);
            if (state.saturated) return REDACTED;
            return state.redactor.redact(value);
        },
        completeInvocation,
        retireGeneration(generation, pluginId): void {
            for (const state of [...statesByScope.values()]) {
                if (state.scope.generation === generation && state.scope.pluginId === pluginId) {
                    completeInvocation(state.scope);
                }
            }
        },
    });
}

type SanitizeState = {
    readonly visited: WeakSet<object>;
    nodes: number;
};

function isSensitivePluginLogKey(key: string): boolean {
    if (isBaseCredentialDiagnosticKey(key)) return true;
    const segments = splitSensitiveDiagnosticKeySegments(key);
    return segments.some((segment) => PLUGIN_LOG_CREDENTIAL_SEGMENTS.has(segment))
        || PLUGIN_LOG_CREDENTIAL_SUFFIXES.has(segments.at(-1) ?? '')
        || segments.some((segment, index) => (
            segment === 'session' && segments[index + 1] === 'id'
        ));
}

function truncateRedactedText(value: string, maxBytes: number, redact?: (value: string) => string): string {
    // Individual structured records identify their failure in the opening text.
    // Redact the complete value before retaining that head: clipping an open
    // quoted credential first can remove its closing quote and expose the rest
    // of the credential as ordinary text.
    const redacted = redact?.(value) ?? redactBugReportSensitiveText(value);
    if (Buffer.byteLength(redacted, 'utf8') <= maxBytes) return redacted;
    const markerBytes = Buffer.byteLength(TRUNCATED, 'utf8');
    return `${trimBugReportTextHeadToMaxBytes(redacted, Math.max(0, maxBytes - markerBytes))}${TRUNCATED}`;
}

function truncateRedactedHeadWithMarker(
    value: string,
    maxBytes: number,
    redact?: (value: string) => string,
): string {
    const redacted = redact?.(value) ?? redactBugReportSensitiveText(value);
    const markerBytes = Buffer.byteLength(TRUNCATED, 'utf8');
    return `${trimBugReportTextHeadToMaxBytes(redacted, Math.max(0, maxBytes - markerBytes))}${TRUNCATED}`;
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
    if (key && isSensitivePluginLogKey(key)) return REDACTED;
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

function boundRecord(
    record: PluginInvocationLogRecord,
    redact?: (value: string) => string,
): PluginInvocationLogRecord {
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
                    message: typeof record.diagnostic.message === 'string'
                        ? truncateRedactedHeadWithMarker(
                            record.diagnostic.message,
                            1024,
                            redact,
                        )
                        : TRUNCATED,
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
        correlationId: params.seed.correlationId,
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
            }, redact);
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
