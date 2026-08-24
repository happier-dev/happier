import { trimBugReportTextHeadToMaxBytes } from '@happier-dev/protocol/bugs/reports';

import type { ExecClientDiagnosticSanitizerV1 } from '../privateContract';

import {
    classifyConnectedServiceSensitiveDiagnosticKey,
    resolveConnectedServiceSensitiveDiagnosticMarker,
} from '@/daemon/connectedServices/runtimeAuth/sensitiveConnectedServiceDiagnosticFields';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';

const DEFAULT_MAX_STRING_BYTES = 2_000;
const DEFAULT_MAX_ARRAY_ITEMS = 20;
const DEFAULT_MAX_OBJECT_KEYS = 40;
const DEFAULT_MAX_DEPTH = 6;

const TRUNCATION_MARKER = true;

type SanitizerState = Readonly<{
    depth: number;
    seen: WeakSet<object>;
    options: NormalizedSanitizerOptions;
}>;

type NormalizedSanitizerOptions = Readonly<{
    redactedValues: readonly string[];
    sensitiveKeys: ReadonlySet<string>;
    maxStringBytes: number;
    maxArrayItems: number;
    maxObjectKeys: number;
    maxDepth: number;
}>;

type TruncatedStringValue = Readonly<{
    __happierRpcDiagnosticTruncated: true;
    originalType: 'string';
    originalBytes: number;
    value: string;
}>;

type TruncatedArrayValue = Readonly<{
    __happierRpcDiagnosticTruncated: true;
    originalType: 'array';
    totalItems: number;
    shownItems: number;
    items: readonly unknown[];
}>;

type TruncatedObjectValue = Readonly<{
    __happierRpcDiagnosticTruncated: true;
    originalType: 'object';
    totalKeys?: number;
    shownKeys?: number;
    reason?: 'circular' | 'maxDepth';
    value?: Readonly<Record<string, unknown>>;
}>;

function normalizeDiagnosticKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readPositiveInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.trunc(value);
}

function normalizeOptions(options: ExecClientDiagnosticSanitizerV1 | undefined): NormalizedSanitizerOptions {
    return Object.freeze({
        redactedValues: Object.freeze([...(options?.redactedValues ?? [])]),
        sensitiveKeys: new Set<string>((options?.sensitiveKeys ?? []).map(normalizeDiagnosticKey)),
        maxStringBytes: readPositiveInteger(options?.maxStringBytes, DEFAULT_MAX_STRING_BYTES),
        maxArrayItems: readPositiveInteger(options?.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS),
        maxObjectKeys: readPositiveInteger(options?.maxObjectKeys, DEFAULT_MAX_OBJECT_KEYS),
        maxDepth: readPositiveInteger(options?.maxDepth, DEFAULT_MAX_DEPTH),
    });
}

function clipStringByBytes(value: string, maxBytes: number): string | TruncatedStringValue {
    const originalBytes = Buffer.byteLength(value, 'utf8');
    if (originalBytes <= maxBytes) {
        return value;
    }
    return Object.freeze({
        __happierRpcDiagnosticTruncated: TRUNCATION_MARKER,
        originalType: 'string',
        originalBytes,
        value: trimBugReportTextHeadToMaxBytes(value, maxBytes),
    });
}

function classifySensitiveKey(key: string | undefined, options: NormalizedSanitizerOptions) {
    if (!key) {
        return null;
    }
    if (options.sensitiveKeys.has(normalizeDiagnosticKey(key))) {
        return 'secret';
    }
    return classifyConnectedServiceSensitiveDiagnosticKey(key);
}

function sanitizeString(value: string, options: NormalizedSanitizerOptions): string | TruncatedStringValue {
    return clipStringByBytes(
        sanitizeConnectedServiceDiagnosticString(value, {
            maxLength: value.length,
            redactedValues: options.redactedValues,
        }),
        options.maxStringBytes,
    );
}

function nextState(state: SanitizerState): SanitizerState {
    return Object.freeze({
        depth: state.depth + 1,
        seen: state.seen,
        options: state.options,
    });
}

function sanitizeArray(value: readonly unknown[], state: SanitizerState, key?: string): readonly unknown[] | TruncatedArrayValue {
    const childState = nextState(state);
    const items = value
        .slice(0, state.options.maxArrayItems)
        .map((item) => sanitizeValue(item, childState, key));
    if (value.length <= state.options.maxArrayItems) {
        return Object.freeze(items);
    }
    return Object.freeze({
        __happierRpcDiagnosticTruncated: TRUNCATION_MARKER,
        originalType: 'array',
        totalItems: value.length,
        shownItems: items.length,
        items: Object.freeze(items),
    });
}

function sanitizeObject(value: object, state: SanitizerState): Readonly<Record<string, unknown>> | TruncatedObjectValue {
    if (state.seen.has(value)) {
        return Object.freeze({
            __happierRpcDiagnosticTruncated: TRUNCATION_MARKER,
            originalType: 'object',
            reason: 'circular',
        });
    }
    if (state.depth >= state.options.maxDepth) {
        return Object.freeze({
            __happierRpcDiagnosticTruncated: TRUNCATION_MARKER,
            originalType: 'object',
            reason: 'maxDepth',
        });
    }

    state.seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    const childState = nextState(state);
    for (const [key, child] of entries.slice(0, state.options.maxObjectKeys)) {
        output[key] = sanitizeValue(child, childState, key);
    }
    state.seen.delete(value);

    if (entries.length <= state.options.maxObjectKeys) {
        return Object.freeze(output);
    }
    return Object.freeze({
        __happierRpcDiagnosticTruncated: TRUNCATION_MARKER,
        originalType: 'object',
        totalKeys: entries.length,
        shownKeys: Object.keys(output).length,
        value: Object.freeze(output),
    });
}

function sanitizeValue(value: unknown, state: SanitizerState, key?: string): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    const sensitiveCategory = classifySensitiveKey(key, state.options);
    if (sensitiveCategory && !Array.isArray(value)) {
        return resolveConnectedServiceSensitiveDiagnosticMarker(sensitiveCategory);
    }
    if (typeof value === 'string') {
        return sanitizeString(value, state.options);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'symbol') {
        return String(value);
    }
    if (typeof value === 'function') {
        return '[Function]';
    }
    if (Array.isArray(value)) {
        return sanitizeArray(value, state, key);
    }
    return sanitizeObject(value, state);
}

export function sanitizeRpcDiagnosticString(
    value: string,
    options?: ExecClientDiagnosticSanitizerV1,
): string {
    const sanitized = sanitizeString(value, normalizeOptions(options));
    return typeof sanitized === 'string' ? sanitized : sanitized.value;
}

export function sanitizeRpcDiagnosticValue(
    value: unknown,
    options?: ExecClientDiagnosticSanitizerV1,
): unknown {
    return sanitizeValue(value, {
        depth: 0,
        seen: new WeakSet<object>(),
        options: normalizeOptions(options),
    });
}
