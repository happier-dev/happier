import { isDeepStrictEqual } from 'node:util';

import type {
    AcpToolIdentity,
    AcpToolLifecycleStatus,
    AcpToolObservation,
    MergedAcpToolCall,
    MergedAcpToolResult,
} from './types';

export type MutableAcpToolCallRecord = {
    identity: AcpToolIdentity;
    sessionId: string;
    turnId: string;
    sidechainId: string | null;
    toolCallId: string;
    revision: number;
    observedAtMs: number;
    status: AcpToolLifecycleStatus;
    semanticName?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    hasRawInput: boolean;
    rawOutput?: unknown;
    hasRawOutput: boolean;
    content?: readonly unknown[];
    locations?: readonly unknown[];
    error?: unknown;
    hasError: boolean;
    resultPublished: boolean;
    publishedResultOutput?: unknown;
    publishedResultIsError?: boolean;
};

const TERMINAL_STATUSES = new Set<AcpToolLifecycleStatus>(['completed', 'failed', 'cancelled']);
const GENERIC_TOOL_IDENTITIES = new Set(['', 'unknown', 'other', 'tool']);

function hasOwn(value: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isGenericToolIdentity(value: string): boolean {
    return GENERIC_TOOL_IDENTITIES.has(value.trim().toLowerCase());
}

function normalizeStatus(value: string | null | undefined): AcpToolLifecycleStatus | null {
    switch (value?.trim().toLowerCase()) {
        case 'pending':
        case 'waiting':
        case 'waiting_for_permission':
            return 'pending';
        case 'running':
        case 'in_progress':
        case 'in-progress':
            return 'running';
        case 'completed':
        case 'complete':
        case 'success':
        case 'succeeded':
            return 'completed';
        case 'failed':
        case 'error':
            return 'failed';
        case 'cancelled':
        case 'canceled':
            return 'cancelled';
        default:
            return null;
    }
}

export function isAcpToolTerminalStatus(status: AcpToolLifecycleStatus): status is Extract<
    AcpToolLifecycleStatus,
    'completed' | 'failed' | 'cancelled'
> {
    return TERMINAL_STATUSES.has(status);
}

export function createMutableAcpToolCallRecord(
    observation: AcpToolObservation,
    identity: AcpToolIdentity,
): MutableAcpToolCallRecord {
    return {
        identity,
        sessionId: observation.sessionId,
        turnId: observation.turnId,
        sidechainId: observation.sidechainId,
        toolCallId: observation.toolCallId,
        revision: 0,
        observedAtMs: observation.observedAtMs,
        status: 'pending',
        hasRawInput: false,
        hasRawOutput: false,
        hasError: false,
        resultPublished: false,
    };
}

function assignIfChanged<T>(record: MutableAcpToolCallRecord, key: keyof MutableAcpToolCallRecord, value: T): boolean {
    if (isDeepStrictEqual(record[key], value)) {
        return false;
    }
    (record as Record<keyof MutableAcpToolCallRecord, unknown>)[key] = value;
    return true;
}

export function mergeAcpToolObservation(
    record: MutableAcpToolCallRecord,
    observation: AcpToolObservation,
): boolean {
    let changed = false;
    const patch = observation.patch;

    if (
        observation.semanticName !== undefined
        && observation.semanticName !== null
        && observation.semanticName.trim().length > 0
    ) {
        const currentName = record.semanticName;
        if (currentName === undefined || isGenericToolIdentity(currentName) || !isGenericToolIdentity(observation.semanticName)) {
            changed = assignIfChanged(record, 'semanticName', observation.semanticName) || changed;
        }
    }
    if (hasOwn(patch, 'title') && patch.title !== undefined) {
        changed = assignIfChanged(record, 'title', patch.title ?? undefined) || changed;
    }
    if (hasOwn(patch, 'kind') && patch.kind !== undefined) {
        if (
            patch.kind === null
            || record.kind === undefined
            || isGenericToolIdentity(record.kind)
            || !isGenericToolIdentity(patch.kind)
        ) {
            changed = assignIfChanged(record, 'kind', patch.kind ?? undefined) || changed;
        }
    }
    if (hasOwn(patch, 'rawInput') && patch.rawInput !== undefined) {
        changed = assignIfChanged(record, 'rawInput', patch.rawInput) || changed;
        changed = !record.hasRawInput || changed;
        record.hasRawInput = true;
    }
    if (hasOwn(patch, 'rawOutput') && patch.rawOutput !== undefined) {
        changed = assignIfChanged(record, 'rawOutput', patch.rawOutput) || changed;
        changed = !record.hasRawOutput || changed;
        record.hasRawOutput = true;
    }
    if (hasOwn(patch, 'error') && patch.error !== undefined) {
        changed = assignIfChanged(record, 'error', patch.error) || changed;
        changed = !record.hasError || changed;
        record.hasError = true;
    }
    if (hasOwn(patch, 'content') && patch.content !== undefined) {
        const content = patch.content === null ? undefined : Object.freeze([...patch.content]);
        changed = assignIfChanged(record, 'content', content) || changed;
    }
    if (hasOwn(patch, 'locations') && patch.locations !== undefined) {
        const locations = patch.locations === null ? undefined : Object.freeze([...patch.locations]);
        changed = assignIfChanged(record, 'locations', locations) || changed;
    }

    const nextStatus = normalizeStatus(patch.status);
    if (nextStatus !== null) {
        const rank: Record<AcpToolLifecycleStatus, number> = {
            pending: 0,
            running: 1,
            completed: 2,
            failed: 2,
            cancelled: 2,
        };
        const currentIsTerminal = isAcpToolTerminalStatus(record.status);
        const nextIsTerminal = isAcpToolTerminalStatus(nextStatus);
        if ((currentIsTerminal && nextIsTerminal) || (!currentIsTerminal && rank[nextStatus] >= rank[record.status])) {
            changed = assignIfChanged(record, 'status', nextStatus) || changed;
        }
    }

    record.revision = observation.revision;
    record.observedAtMs = observation.observedAtMs;
    return changed;
}

function resolveToolName(record: MutableAcpToolCallRecord): string {
    return record.semanticName ?? record.kind ?? 'other';
}

export function snapshotAcpToolCall(record: MutableAcpToolCallRecord): MergedAcpToolCall {
    return Object.freeze({
        sessionId: record.sessionId,
        turnId: record.turnId,
        sidechainId: record.sidechainId,
        toolCallId: record.toolCallId,
        localId: record.identity.callLocalId,
        resultLocalId: record.identity.resultLocalId,
        toolName: resolveToolName(record),
        ...(record.title !== undefined ? { title: record.title } : {}),
        ...(record.kind !== undefined ? { kind: record.kind } : {}),
        status: record.status,
        ...(record.hasRawInput ? { rawInput: record.rawInput } : {}),
        ...(record.content !== undefined ? { content: record.content } : {}),
        ...(record.locations !== undefined ? { locations: record.locations } : {}),
        observedAtMs: record.observedAtMs,
    });
}

export function snapshotAcpToolResult(record: MutableAcpToolCallRecord): MergedAcpToolResult | null {
    if (!isAcpToolTerminalStatus(record.status)) {
        return null;
    }
    return Object.freeze({
        sessionId: record.sessionId,
        turnId: record.turnId,
        sidechainId: record.sidechainId,
        toolCallId: record.toolCallId,
        localId: record.identity.resultLocalId,
        callLocalId: record.identity.callLocalId,
        toolName: resolveToolName(record),
        status: record.status,
        ...(record.hasRawOutput ? { rawOutput: record.rawOutput } : {}),
        ...(record.hasError ? { error: record.error } : {}),
        isError: record.status !== 'completed' || record.hasError,
        observedAtMs: record.observedAtMs,
    });
}

/**
 * Claims publication for the first result or a materially changed result projection. Runtime
 * consumers use the stable result local ID to revise one durable logical row.
 */
export function claimAcpToolResultPublication(
    record: MutableAcpToolCallRecord,
    result: MergedAcpToolResult | null,
): boolean {
    if (result === null) return false;
    const output = hasOwn(result, 'rawOutput') ? result.rawOutput : result.error;
    if (
        record.resultPublished
        && record.publishedResultIsError === result.isError
        && isDeepStrictEqual(record.publishedResultOutput, output)
    ) {
        return false;
    }
    record.resultPublished = true;
    record.publishedResultOutput = output;
    record.publishedResultIsError = result.isError;
    return true;
}
