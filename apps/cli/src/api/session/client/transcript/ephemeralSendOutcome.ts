import {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

const ERROR_TEXT_MAX_BYTES = 4_096;
const ERROR_NAME_MAX_CHARS = 160;
const ERROR_CAUSE_MAX_DEPTH = 2;

export type BoundedStructuredError = Readonly<{
    name: string;
    message: string;
    stack?: string;
    code?: string;
    cause?: BoundedStructuredError;
}>;

export type EphemeralSendFailureReason =
    | 'disconnected'
    | 'prepare_failed'
    | 'serialize_failed'
    | 'observe_failed'
    | 'emit_failed'
    | 'transport_unavailable'
    | 'connection_epoch_changed';

export type EphemeralSendOutcome =
    | Readonly<{ accepted: true; epoch: number }>
    | Readonly<{
        accepted: false;
        epoch: number;
        reason: EphemeralSendFailureReason;
        error?: BoundedStructuredError;
    }>;

export type EphemeralSendResult = EphemeralSendOutcome | Promise<EphemeralSendOutcome>;

function normalizeEpoch(epoch: unknown): number {
    return typeof epoch === 'number' && Number.isFinite(epoch)
        ? Math.max(0, Math.trunc(epoch))
        : 0;
}

function isValidEpoch(epoch: unknown): epoch is number {
    return typeof epoch === 'number' && Number.isFinite(epoch) && epoch >= 0;
}

function safeString(value: unknown): string {
    try {
        return String(value);
    } catch {
        return 'Unknown error';
    }
}

function sanitizeText(value: unknown): string {
    return trimBugReportTextToMaxBytes(
        redactBugReportSensitiveText(safeString(value)),
        ERROR_TEXT_MAX_BYTES,
    ).trim();
}

function sanitizeMessage(value: unknown): string {
    return sanitizeText(serializeAxiosErrorForLog(new Error(safeString(value))).message);
}

function sanitizeName(value: unknown): string {
    return sanitizeText(value)
        .replace(/[^A-Za-z0-9_.:-]/gu, '')
        .slice(0, ERROR_NAME_MAX_CHARS) || 'Error';
}

function readStringField(error: unknown, field: 'name' | 'message' | 'stack' | 'code'): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    try {
        const value = (error as Record<string, unknown>)[field];
        return typeof value === 'string' ? value : undefined;
    } catch {
        return undefined;
    }
}

function readCause(error: unknown): unknown {
    if (typeof error !== 'object' || error === null) return undefined;
    try {
        return (error as { cause?: unknown }).cause;
    } catch {
        return undefined;
    }
}

function serializeFallbackError(error: unknown): Record<string, unknown> {
    try {
        return serializeAxiosErrorForLog(error);
    } catch {
        return { name: 'Error', message: 'Unknown error' };
    }
}

function serializeError(error: unknown, depth: number): BoundedStructuredError {
    const fallback = serializeFallbackError(error);
    const name = sanitizeName(readStringField(error, 'name') ?? fallback.name ?? 'Error');
    const message = sanitizeMessage(readStringField(error, 'message') ?? fallback.message ?? error) || 'Unknown error';
    const rawStack = readStringField(error, 'stack');
    const stack = rawStack ? sanitizeMessage(rawStack) : '';
    const rawCode = readStringField(error, 'code') ?? fallback.code;
    const code = typeof rawCode === 'string' ? sanitizeName(rawCode) : '';
    const cause = depth < ERROR_CAUSE_MAX_DEPTH ? readCause(error) : undefined;

    return {
        name,
        message,
        ...(stack ? { stack } : {}),
        ...(code ? { code } : {}),
        ...(cause === undefined ? {} : { cause: serializeError(cause, depth + 1) }),
    };
}

export function serializeEphemeralSendError(error: unknown): BoundedStructuredError {
    return serializeError(error, 0);
}

export function createEphemeralSendFailure(
    reason: EphemeralSendFailureReason,
    epoch: unknown,
    error?: unknown,
): Extract<EphemeralSendOutcome, { accepted: false }> {
    return {
        accepted: false,
        epoch: normalizeEpoch(epoch),
        reason,
        ...(error === undefined ? {} : { error: serializeEphemeralSendError(error) }),
    };
}

const FAILURE_REASONS = new Set<EphemeralSendFailureReason>([
    'disconnected',
    'prepare_failed',
    'serialize_failed',
    'observe_failed',
    'emit_failed',
    'transport_unavailable',
    'connection_epoch_changed',
]);

/** Fail closed: an adapter's malformed result never establishes a delta baseline. */
export function normalizeEphemeralSendOutcome(value: unknown, fallbackEpoch: unknown): EphemeralSendOutcome {
    if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        const epoch = normalizeEpoch(record.epoch);
        if (record.accepted === true && isValidEpoch(record.epoch)) return { accepted: true, epoch };
        if (
            record.accepted === false
            && typeof record.reason === 'string'
            && FAILURE_REASONS.has(record.reason as EphemeralSendFailureReason)
        ) {
            return createEphemeralSendFailure(
                record.reason as EphemeralSendFailureReason,
                epoch,
                record.error,
            );
        }
    }
    return createEphemeralSendFailure(
        'transport_unavailable',
        fallbackEpoch,
        new Error('Ephemeral send returned an invalid local acceptance outcome'),
    );
}
