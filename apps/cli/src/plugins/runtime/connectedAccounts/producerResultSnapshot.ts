import {
    PluginDiagnosticDataV1Schema,
} from '@happier-dev/protocol';
import type {
    ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
    ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { clonePluginPlainData } from '../plainData';
import type {
    ConnectedAccountRuntimeEstablishedOperation,
    ConnectedAccountRuntimeEstablishedResult,
} from './runtimeInvoker';

type PluginConnectedAccountRefreshResult = Awaited<
    ReturnType<PluginConnectedAccountRuntime['refresh']>
>;
type PluginConnectedAccountRevocationResult = Awaited<
    ReturnType<PluginConnectedAccountRuntime['revoke']>
>;
type PluginConnectedAccountQuotaSnapshot = Awaited<
    ReturnType<NonNullable<PluginConnectedAccountRuntime['quota']>>
>;

export type ConnectedAccountProducerResultErrorCode =
    | 'connected_account_producer_result_invalid'
    | 'connected_account_producer_result_stale';

export class ConnectedAccountProducerResultError extends Error {
    readonly code: ConnectedAccountProducerResultErrorCode;
    readonly operation: ConnectedAccountRuntimeEstablishedOperation['kind'];

    constructor(
        code: ConnectedAccountProducerResultErrorCode,
        operation: ConnectedAccountRuntimeEstablishedOperation['kind'],
    ) {
        super(
            code === 'connected_account_producer_result_stale'
                ? 'Connected-account established runtime target is no longer current'
                : 'Connected-account producer result is invalid',
        );
        this.name = 'ConnectedAccountProducerResultError';
        this.code = code;
        this.operation = operation;
    }
}

function invalidResult(
    operation: ConnectedAccountRuntimeEstablishedOperation['kind'],
): ConnectedAccountProducerResultError {
    return new ConnectedAccountProducerResultError(
        'connected_account_producer_result_invalid',
        operation,
    );
}

export function staleConnectedAccountProducerResult(
    operation: ConnectedAccountRuntimeEstablishedOperation['kind'],
): ConnectedAccountProducerResultError {
    return new ConnectedAccountProducerResultError(
        'connected_account_producer_result_stale',
        operation,
    );
}

export function readStrictConnectedAccountProducerRecord(
    value: unknown,
    allowedKeys: readonly string[] | null,
    requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
        keys.some((key) => (
            typeof key !== 'string'
            || (allowedKeys !== null && !allowedKeys.includes(key))
        ))
        || requiredKeys.some((key) => !keys.includes(key))
    ) {
        return null;
    }
    const output: Record<string, unknown> =
        Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (
            !property
            || !property.enumerable
            || !('value' in property)
        ) {
            return null;
        }
        Object.defineProperty(output, key, {
            value: property.value,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    return Object.freeze(output);
}

function cloneStrictJsonResult(
    value: unknown,
    operation: ConnectedAccountRuntimeEstablishedOperation['kind'],
): unknown {
    return clonePluginPlainData(value, {
        path: `Connected Account ${operation} result`,
        invalid: () => invalidResult(operation),
    });
}

type RedactConnectedAccountDiagnosticText = (value: string) => string;

type RedactConnectedAccountDiagnosticDetailsTask = Readonly<{
    input: unknown;
    assign(value: unknown): void;
}>;

/**
 * The surrounding diagnostic has already passed the Protocol schema before
 * this runs. This is intentionally a redaction projection, not another JSON
 * validator: the existing strict clone and schema remain the only admission
 * owner for Connected Account diagnostics.
 */
function redactConnectedAccountDiagnosticDetails(
    value: unknown,
    redactText: RedactConnectedAccountDiagnosticText,
): unknown {
    let output: unknown;
    const tasks: RedactConnectedAccountDiagnosticDetailsTask[] = [{
        input: value,
        assign(next) {
            output = next;
        },
    }];
    while (tasks.length > 0) {
        const task = tasks.pop();
        if (!task) continue;
        if (typeof task.input === 'string') {
            const redacted = redactText(task.input);
            if (typeof redacted !== 'string') {
                throw new TypeError('Connected Account diagnostic redactor returned non-text');
            }
            task.assign(redacted);
            continue;
        }
        if (
            task.input === null
            || typeof task.input === 'boolean'
            || typeof task.input === 'number'
        ) {
            task.assign(task.input);
            continue;
        }
        if (Array.isArray(task.input)) {
            const redacted = new Array<unknown>(task.input.length);
            task.assign(redacted);
            for (let index = task.input.length - 1; index >= 0; index -= 1) {
                const valueAtIndex = task.input[index];
                tasks.push({
                    input: valueAtIndex,
                    assign(next) {
                        redacted[index] = next;
                    },
                });
            }
            continue;
        }
        if (typeof task.input !== 'object') {
            throw new TypeError('Connected Account diagnostic details are not JSON');
        }
        const redacted: Record<string, unknown> =
            Object.create(null) as Record<string, unknown>;
        task.assign(redacted);
        for (const key of Object.keys(task.input).reverse()) {
            const property = Object.getOwnPropertyDescriptor(task.input, key);
            if (!property || !('value' in property)) {
                throw new TypeError('Connected Account diagnostic details have a non-data property');
            }
            tasks.push({
                input: property.value,
                assign(next) {
                    Object.defineProperty(redacted, key, {
                        value: next,
                        enumerable: true,
                        writable: false,
                        configurable: false,
                    });
                },
            });
        }
    }
    return output;
}

export function cloneBoundedConnectedAccountDiagnostic(
    value: unknown,
    redactDiagnosticText?: RedactConnectedAccountDiagnosticText,
): Readonly<Record<string, unknown>> | null {
    try {
        const snapshot = clonePluginPlainData(value, {
            path: 'Connected Account diagnostic',
            invalid: () => new TypeError('Invalid Connected Account diagnostic'),
        });
        const parsed = PluginDiagnosticDataV1Schema.safeParse(snapshot);
        if (!parsed.success) return null;
        const redacted = redactDiagnosticText === undefined
            ? parsed.data
            : {
                ...parsed.data,
                ...(parsed.data.message === undefined
                    ? {}
                    : { message: redactDiagnosticText(parsed.data.message) }),
                ...(parsed.data.details === undefined
                    ? {}
                    : {
                        details: redactConnectedAccountDiagnosticDetails(
                            parsed.data.details,
                            redactDiagnosticText,
                        ),
                    }),
            };
        const redactedParsed = PluginDiagnosticDataV1Schema.safeParse(redacted);
        if (!redactedParsed.success) return null;
        return clonePluginPlainData(redactedParsed.data, {
            path: 'Connected Account diagnostic',
            invalid: () => new TypeError('Invalid Connected Account diagnostic'),
        }) as Readonly<Record<string, unknown>>;
    } catch {
        return null;
    }
}

/**
 * Authentication-result shape and outcome semantics remain with the attempt
 * owner. While the invocation's credential-redaction scope is still active,
 * this producer boundary replaces an admitted diagnostic with the canonical
 * diagnostic snapshot. Results without a safe own diagnostic reach that owner
 * unchanged; an admitted diagnostic that cannot be redacted fails closed.
 */
export function redactConnectedAccountAuthenticationResultDiagnostic(
    value: unknown,
    redactDiagnosticText: RedactConnectedAccountDiagnosticText,
): unknown {
    const record = readStrictConnectedAccountProducerRecord(value, null, []);
    if (
        record === null
        || !Object.prototype.hasOwnProperty.call(record, 'diagnostic')
    ) {
        return value;
    }
    const diagnostic = cloneBoundedConnectedAccountDiagnostic(
        record.diagnostic,
        redactDiagnosticText,
    );
    if (diagnostic === null) {
        throw new TypeError('Connected Account diagnostic redaction failed');
    }
    const output: Record<string, unknown> =
        Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(record)) {
        if (typeof key !== 'string') {
            throw new TypeError('Connected Account authentication result has a non-string key');
        }
        Object.defineProperty(output, key, {
            value: key === 'diagnostic' ? diagnostic : record[key],
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    return Object.freeze(output);
}

function hasExactKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): boolean {
    const expected = new Set(keys);
    const actual = Reflect.ownKeys(value);
    return actual.length === expected.size
        && actual.every((key) => (
            typeof key === 'string' && expected.has(key)
        ));
}

function isBoundedString(
    value: unknown,
    maxLength = 4_096,
): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength;
}

function snapshotScopes(
    value: unknown,
): readonly string[] | null {
    if (
        !Array.isArray(value)
        || value.length > 128
        || !value.every((scope) => isBoundedString(scope, 256))
        || new Set(value).size !== value.length
    ) {
        return null;
    }
    return Object.freeze([...(value as string[])]);
}

function snapshotHealthResult(
    raw: unknown,
    operation: 'refresh' | 'status',
    allowOutcomeUnknown: boolean,
    redactDiagnosticText?: RedactConnectedAccountDiagnosticText,
): PluginConnectedAccountRefreshResult | null {
    const snapshot = cloneStrictJsonResult(raw, operation);
    const record = readStrictConnectedAccountProducerRecord(
        snapshot,
        ['status', 'displayName', 'scopes', 'diagnostic'],
        ['status'],
    );
    if (!record || typeof record.status !== 'string') return null;
    if (allowOutcomeUnknown && record.status === 'outcomeUnknown') {
        if (!hasExactKeys(record, ['status', 'diagnostic'])) return null;
        const diagnostic =
            cloneBoundedConnectedAccountDiagnostic(
                record.diagnostic,
                redactDiagnosticText,
            );
        return diagnostic
            ? Object.freeze({
                status: 'outcomeUnknown' as const,
                diagnostic,
            }) as PluginConnectedAccountRefreshResult
            : null;
    }
    if (
        record.status !== 'connected'
        && record.status !== 'expired'
        && record.status !== 'reconnectRequired'
        && record.status !== 'unavailable'
        && record.status !== 'rejected'
    ) {
        return null;
    }
    if (
        record.status === 'rejected'
        && !hasExactKeys(record, ['status', 'diagnostic'])
    ) {
        return null;
    }
    if (
        record.displayName !== undefined
        && !isBoundedString(record.displayName, 512)
    ) {
        return null;
    }
    const scopes = record.scopes === undefined
        ? undefined
        : snapshotScopes(record.scopes);
    if (record.scopes !== undefined && !scopes) return null;
    const diagnostic = record.diagnostic === undefined
        ? undefined
        : cloneBoundedConnectedAccountDiagnostic(
            record.diagnostic,
            redactDiagnosticText,
        ) ?? undefined;
    if (record.status === 'rejected' && diagnostic === undefined) {
        return null;
    }
    return Object.freeze({
        status: record.status,
        ...(record.displayName === undefined
            ? {}
            : { displayName: record.displayName }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
    }) as PluginConnectedAccountHealthResult;
}

function snapshotRevocationResult(
    raw: unknown,
    redactDiagnosticText?: RedactConnectedAccountDiagnosticText,
): PluginConnectedAccountRevocationResult | null {
    const snapshot = cloneStrictJsonResult(raw, 'revoke');
    const record = readStrictConnectedAccountProducerRecord(
        snapshot,
        ['status', 'diagnostic'],
        ['status'],
    );
    if (!record || typeof record.status !== 'string') return null;
    if (
        record.status !== 'remoteRevoked'
        && record.status !== 'remoteUnsupported'
        && record.status !== 'outcomeUnknown'
    ) {
        return null;
    }
    const diagnostic = record.diagnostic === undefined
        ? undefined
        : cloneBoundedConnectedAccountDiagnostic(
            record.diagnostic,
            redactDiagnosticText,
        ) ?? undefined;
    if (record.status === 'outcomeUnknown' && diagnostic === undefined) {
        return null;
    }
    return Object.freeze({
        status: record.status,
        ...(diagnostic === undefined ? {} : { diagnostic }),
    }) as PluginConnectedAccountRevocationResult;
}

function snapshotQuotaResult(
    raw: unknown,
): PluginConnectedAccountQuotaSnapshot | null {
    const snapshot = cloneStrictJsonResult(raw, 'quota');
    const record = readStrictConnectedAccountProducerRecord(
        snapshot,
        ['observedAtMs', 'limits'],
        ['observedAtMs', 'limits'],
    );
    if (
        !record
        || !Number.isSafeInteger(record.observedAtMs)
        || Number(record.observedAtMs) < 0
        || !Array.isArray(record.limits)
        || record.limits.length > 128
    ) {
        return null;
    }
    const ids = new Set<string>();
    const limits: Array<Readonly<{
        id: string;
        used?: number;
        remaining?: number;
        resetsAtMs?: number;
    }>> = [];
    for (const rawLimit of record.limits) {
        const limit = readStrictConnectedAccountProducerRecord(
            rawLimit,
            ['id', 'used', 'remaining', 'resetsAtMs'],
            ['id'],
        );
        if (
            !limit
            || !isBoundedString(limit.id, 256)
            || ids.has(limit.id)
            || (
                limit.used !== undefined
                && (
                    !Number.isFinite(limit.used)
                    || Number(limit.used) < 0
                )
            )
            || (
                limit.remaining !== undefined
                && (
                    !Number.isFinite(limit.remaining)
                    || Number(limit.remaining) < 0
                )
            )
            || (
                limit.resetsAtMs !== undefined
                && (
                    !Number.isSafeInteger(limit.resetsAtMs)
                    || Number(limit.resetsAtMs) < 0
                )
            )
        ) {
            return null;
        }
        ids.add(limit.id);
        limits.push(Object.freeze({
            id: limit.id,
            ...(limit.used === undefined
                ? {}
                : { used: Number(limit.used) }),
            ...(limit.remaining === undefined
                ? {}
                : { remaining: Number(limit.remaining) }),
            ...(limit.resetsAtMs === undefined
                ? {}
                : { resetsAtMs: Number(limit.resetsAtMs) }),
        }));
    }
    return Object.freeze({
        observedAtMs: Number(record.observedAtMs),
        limits: Object.freeze(limits),
    });
}

function snapshotStringMaterializationRecord(input: Readonly<{
    value: unknown;
    requestedKeys: readonly string[];
    caseInsensitive: boolean;
    rejectNewlines: boolean;
}>): Readonly<Record<string, string>> | null {
    const record = readStrictConnectedAccountProducerRecord(
        input.value,
        null,
        [],
    );
    if (!record) return null;
    const requested = new Set(input.requestedKeys.map((key) => (
        input.caseInsensitive ? key.toLowerCase() : key
    )));
    const returned = new Set<string>();
    const output: Record<string, string> =
        Object.create(null) as Record<string, string>;
    for (const key of Reflect.ownKeys(record)) {
        if (typeof key !== 'string') return null;
        const normalizedKey = input.caseInsensitive
            ? key.toLowerCase()
            : key;
        const value = record[key];
        if (
            !isBoundedString(key, 256)
            || !requested.has(normalizedKey)
            || returned.has(normalizedKey)
            || typeof value !== 'string'
            || (input.rejectNewlines && /[\r\n]/u.test(value))
        ) {
            return null;
        }
        returned.add(normalizedKey);
        Object.defineProperty(output, key, {
            value,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    return Object.freeze(output);
}

function snapshotFileMaterialization(
    raw: unknown,
    request: Extract<
        ConnectedAccountRuntimeEstablishedOperation,
        { kind: 'materialize' }
    >['request'],
): PluginConnectedAccountMaterialization | null {
    if (request.kind !== 'files') return null;
    const result = readStrictConnectedAccountProducerRecord(
        raw,
        ['kind', 'files'],
        ['kind', 'files'],
    );
    if (!result || result.kind !== 'files') return null;
    const files = readStrictConnectedAccountProducerRecord(
        result.files,
        null,
        [],
    );
    if (!files) return null;
    const requested = new Set(request.fileIds);
    const output: Record<string, Uint8Array> =
        Object.create(null) as Record<string, Uint8Array>;
    for (const fileId of Reflect.ownKeys(files)) {
        if (typeof fileId !== 'string') return null;
        const bytes = files[fileId];
        if (
            !isBoundedString(fileId, 256)
            || !requested.has(fileId)
            || !(bytes instanceof Uint8Array)
        ) {
            return null;
        }
        // Construct a plain Uint8Array so a Buffer/subclass species cannot
        // leak its prototype into the host-owned snapshot.
        const copied = new Uint8Array(bytes);
        Object.defineProperty(output, fileId, {
            value: copied,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    return Object.freeze({
        kind: 'files' as const,
        files: Object.freeze(output),
    });
}

function snapshotMaterializationResult(
    raw: unknown,
    request: Extract<
        ConnectedAccountRuntimeEstablishedOperation,
        { kind: 'materialize' }
    >['request'],
): PluginConnectedAccountMaterialization | null {
    if (request.kind === 'files') {
        return snapshotFileMaterialization(raw, request);
    }
    const snapshot = cloneStrictJsonResult(raw, 'materialize');
    const result = readStrictConnectedAccountProducerRecord(
        snapshot,
        request.kind === 'httpHeaders'
            ? ['kind', 'headers']
            : ['kind', 'env'],
        request.kind === 'httpHeaders'
            ? ['kind', 'headers']
            : ['kind', 'env'],
    );
    if (!result || result.kind !== request.kind) return null;
    if (request.kind === 'httpHeaders') {
        const headers = snapshotStringMaterializationRecord({
            value: result.headers,
            requestedKeys: request.headerNames,
            caseInsensitive: true,
            rejectNewlines: true,
        });
        return headers
            ? Object.freeze({
                kind: 'httpHeaders' as const,
                headers,
            })
            : null;
    }
    const env = snapshotStringMaterializationRecord({
        value: result.env,
        requestedKeys: request.keys,
        caseInsensitive: false,
        rejectNewlines: false,
    });
    return env
        ? Object.freeze({
            kind: 'environment' as const,
            env,
        })
        : null;
}

export function snapshotConnectedAccountEstablishedResult<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation,
>(
    operation: TOperation,
    raw: unknown,
    options: Readonly<{
        quotaLeafUnavailable: boolean;
        redactDiagnosticText?: RedactConnectedAccountDiagnosticText;
    }>,
): ConnectedAccountRuntimeEstablishedResult<TOperation> {
    try {
        let snapshot:
            | PluginConnectedAccountRefreshResult
            | PluginConnectedAccountHealthResult
            | PluginConnectedAccountQuotaSnapshot
            | PluginConnectedAccountRevocationResult
            | PluginConnectedAccountMaterialization
            | null;
        switch (operation.kind) {
            case 'refresh':
                snapshot = snapshotHealthResult(
                    raw,
                    'refresh',
                    true,
                    options.redactDiagnosticText,
                );
                break;
            case 'status':
                snapshot = snapshotHealthResult(
                    raw,
                    'status',
                    false,
                    options.redactDiagnosticText,
                );
                break;
            case 'quota':
                snapshot = options.quotaLeafUnavailable
                    ? null
                    : snapshotQuotaResult(raw);
                break;
            case 'revoke':
                snapshot = snapshotRevocationResult(
                    raw,
                    options.redactDiagnosticText,
                );
                break;
            case 'materialize':
                snapshot = snapshotMaterializationResult(
                    raw,
                    operation.request,
                );
                break;
        }
        if (
            snapshot === null
            && !(
                operation.kind === 'quota'
                && options.quotaLeafUnavailable
                && raw === null
            )
        ) {
            throw invalidResult(operation.kind);
        }
        return snapshot as ConnectedAccountRuntimeEstablishedResult<TOperation>;
    } catch (error) {
        if (error instanceof ConnectedAccountProducerResultError) throw error;
        throw invalidResult(operation.kind);
    }
}
