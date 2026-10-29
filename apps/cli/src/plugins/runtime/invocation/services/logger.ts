import { createSensitiveDiagnosticTextRedactor, redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import type { SensitiveDiagnosticTextRedactor, SensitiveDiagnosticValuesLease } from '@happier-dev/protocol/bugs/reports';
import { isBaseCredentialDiagnosticKey, splitSensitiveDiagnosticKeySegments } from '@happier-dev/protocol/diagnostics/sensitive-keys';
import type { JsonValue, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { LoggerService as PluginLoggerService } from '@happier-dev/plugin-sdk';

import type { PluginInvocationServicesSeed } from './types';
import { projectTargetActionDiagnosticIssue } from '../diagnostics';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
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
        occurrenceId: string;
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
    occurrenceId: string;
    correlationId: string;
}>;

export type PluginInvocationSecretRedactor = Readonly<{
    beginInvocation(scope: PluginInvocationSecretRedactionScope, signal: AbortSignal): void;
    registerRaw(scope: PluginInvocationSecretRedactionScope, value: string): void;
    registerExact(scope: PluginInvocationSecretRedactionScope, value: string): void;
    registerConfidentialPaths(scope: PluginInvocationSecretRedactionScope, paths: readonly string[], nonStringPaths: readonly string[]): void;
    isConfidentialPath(scope: PluginInvocationSecretRedactionScope, path: readonly string[]): boolean;
    projectIssue(scope: PluginInvocationSecretRedactionScope, value: unknown): ReturnType<typeof projectTargetActionDiagnosticIssue>;
    redact(scope: PluginInvocationSecretRedactionScope, value: string): string;
    completeInvocation(scope: PluginInvocationSecretRedactionScope): void;
    retireGeneration(occurrenceId: string, pluginId: string): void;
}>;

function secretRedactionScopeKey(scope: PluginInvocationSecretRedactionScope): string {
    return `${scope.occurrenceId}\u0000${scope.pluginId}\u0000${scope.correlationId}`;
}

type PluginInvocationSecretRedactionState = {
    readonly scope: PluginInvocationSecretRedactionScope;
    readonly redactor: SensitiveDiagnosticTextRedactor;
    readonly values: Set<string>;
    readonly leases: SensitiveDiagnosticValuesLease[];
    readonly confidentialPaths: Set<string>;
    readonly nonStringPaths: Set<string>;
    disposeSignal?: () => void;
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
                confidentialPaths: new Set(),
                nonStringPaths: new Set(),
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
        try {
            state.leases.push(state.redactor.register([value]));
            state.values.add(value);
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
            const bytes = Buffer.from(value, 'utf8');
            registerExact(scope, bytes.toString('base64'));
            registerExact(scope, bytes.toString('base64url'));
            registerExact(scope, bytes.toString('hex'));
        },
        registerExact,
        registerConfidentialPaths(scope, paths, nonStringPaths): void {
            const state = statesByScope.get(secretRedactionScopeKey(scope));
            if (state) {
                for (const path of paths) state.confidentialPaths.add(path);
                for (const path of nonStringPaths) state.nonStringPaths.add(path);
            }
        },
        isConfidentialPath(scope, path): boolean {
            const state = statesByScope.get(secretRedactionScopeKey(scope));
            return state?.confidentialPaths.has(path.join('.')) ?? false;
        },
        projectIssue(scope, value) {
            const state = statesByScope.get(secretRedactionScopeKey(scope));
            return state && state.confidentialPaths.size > 0
                ? projectTargetActionDiagnosticIssue(value, {
                    paths: [...state.confidentialPaths], nonStringPaths: [...state.nonStringPaths],
                }) : null;
        },
        redact(scope, value): string {
            const state = statesByScope.get(secretRedactionScopeKey(scope));
            if (!state) return baselineRedactor.redact(value);
            if (state.saturated) return REDACTED;
            return state.redactor.redact(value);
        },
        completeInvocation,
        retireGeneration(occurrenceId, pluginId): void {
            for (const state of [...statesByScope.values()]) {
                if (state.scope.occurrenceId === occurrenceId && state.scope.pluginId === pluginId) {
                    completeInvocation(state.scope);
                }
            }
        },
    });
}

type DiagnosticProjection = Readonly<{
    isConfidentialPath(path: readonly string[]): boolean;
    projectIssue(value: unknown): ReturnType<typeof projectTargetActionDiagnosticIssue>;
}>;

function isSensitivePluginLogKey(key: string): boolean {
    if (isBaseCredentialDiagnosticKey(key)) return true;
    const segments = splitSensitiveDiagnosticKeySegments(key);
    return segments.some((segment) => PLUGIN_LOG_CREDENTIAL_SEGMENTS.has(segment))
        || PLUGIN_LOG_CREDENTIAL_SUFFIXES.has(segments.at(-1) ?? '')
        || segments.some((segment, index) => (
            segment === 'session' && segments[index + 1] === 'id'
        ));
}

function redactText(value: string, redact?: (value: string) => string): string {
    return redact?.(value) ?? redactBugReportSensitiveText(value);
}

function sanitizeValue(
    value: unknown,
    visited: WeakSet<object>,
    key?: string,
    redact?: (value: string) => string,
    projection?: DiagnosticProjection,
    path: readonly string[] = [],
): JsonValue {
    if (projection?.isConfidentialPath(path)) return REDACTED;
    if (key && isSensitivePluginLogKey(key)) return REDACTED;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        return typeof value === 'number' && !Number.isFinite(value) ? null : value;
    }
    if (typeof value === 'string') return redactText(value, redact);
    if (typeof value === 'bigint') return redactText(value.toString());
    if (typeof value !== 'object') return `[Unsupported:${typeof value}]`;
    if (visited.has(value)) return CIRCULAR;
    visited.add(value);
    const source = projection?.projectIssue(value) ?? value;
    if (Array.isArray(source)) {
        return source.map((item, index) => sanitizeValue(item, visited, undefined, redact, projection, [...path, String(index)]));
    }
    const output: Record<string, JsonValue> = {};
    let entries: [string, unknown][];
    try {
        entries = Object.entries(source);
    } catch {
        return '[Unsupported:object]';
    }
    for (const [entryKey, entryValue] of entries) {
        output[redactText(entryKey, redact)] = sanitizeValue(entryValue, visited, entryKey, redact, projection, [...path, entryKey]);
    }
    return output;
}

function sanitizeRecord(
    value: unknown,
    redact?: (value: string) => string,
    projection?: DiagnosticProjection,
): Readonly<Record<string, JsonValue>> {
    const sanitized = sanitizeValue(value, new WeakSet(), undefined, redact, projection);
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
    projection?: DiagnosticProjection,
): Readonly<Record<string, JsonValue>> {
    const candidate = {
        code: data.code,
        severity: data.severity,
        ...(data.message === undefined ? {} : { message: data.message }),
        ...(data.details === undefined ? {} : { details: data.details }),
        ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
    };
    return sanitizeRecord(candidate, redact, projection ? {
        ...projection,
        isConfidentialPath: path => path[0] === 'details' && projection.isConfidentialPath(path.slice(1)),
    } : undefined);
}

function freezeRecord(record: PluginInvocationLogRecord): PluginInvocationLogRecord {
    if (record.fields) Object.freeze(record.fields);
    if (record.diagnostic) Object.freeze(record.diagnostic);
    Object.freeze(record.context.plugin);
    Object.freeze(record.context.contribution);
    Object.freeze(record.context);
    return Object.freeze(record);
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
            id: redactText(params.seed.plugin.id),
            version: redactText(params.seed.plugin.version),
        }),
        contribution: Object.freeze({
            id: redactText(params.seed.contribution.id),
            qualifiedId: redactText(params.seed.contribution.qualifiedId),
        }),
        occurrenceId: redactText(params.seed.occurrenceId),
        correlationId: redactText(params.seed.correlationId),
        surface: params.seed.surface,
    });
    const redactionScope = Object.freeze({
        pluginId: params.seed.plugin.id,
        occurrenceId: params.seed.occurrenceId,
        correlationId: params.seed.correlationId,
    });
    const redact = params.secretRedactor
        ? (value: string): string => params.secretRedactor!.redact(redactionScope, value)
        : undefined;
    const projection: DiagnosticProjection | undefined = params.secretRedactor
        ? {
            isConfidentialPath: path => params.secretRedactor!.isConfidentialPath(redactionScope, path),
            projectIssue: value => params.secretRedactor!.projectIssue(redactionScope, value),
        }
        : undefined;
    const emit = (
        level: PluginInvocationLogLevel,
        input: Readonly<{ message?: string; fields?: Readonly<Record<string, JsonValue>>; diagnostic?: PluginDiagnosticData }>,
    ): void => {
        try {
            if (params.seed.signal.aborted || !params.seed.isOccurrenceCurrent()) return;
            const message = input.message === undefined
                ? undefined
                : redactText(input.message, redact);
            // Consume declaration-owned paths before redacting keys/text. Opaque prose has no path.
            const fields = input.fields === undefined ? undefined : sanitizeRecord(input.fields, redact, projection);
            const diagnostic = input.diagnostic === undefined ? undefined : sanitizeDiagnostic(input.diagnostic, redact, projection);
            if (params.seed.signal.aborted || !params.seed.isOccurrenceCurrent()) return;
            const nextSequence = sequence + 1;
            const record = freezeRecord({
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
            if (params.seed.signal.aborted || !params.seed.isOccurrenceCurrent()) return;
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
