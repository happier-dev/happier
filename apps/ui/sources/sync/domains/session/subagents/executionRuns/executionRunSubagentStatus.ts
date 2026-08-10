import { ExecutionRunStatusSchema, type ExecutionRunStatus } from '@happier-dev/protocol';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

import type { SessionSubagentStatus } from '../types';

/**
 * The execution-run status vocabulary is owned by the protocol schema, never re-declared here:
 * a new member flows in without a lockstep edit, and the mappings below stop compiling until it
 * has an explicit presentation meaning.
 */
const EXECUTION_RUN_STATUSES: ReadonlySet<string> = new Set<string>(ExecutionRunStatusSchema.options);

/**
 * Wire spellings written by older CLI lines for the same terminal outcomes. Explicit and closed:
 * an unrecognised word is *not* a status, it falls through to the tool-call lifecycle below.
 */
const LEGACY_EXECUTION_RUN_STATUS_ALIASES: Readonly<Record<string, ExecutionRunStatus>> = {
    completed: 'succeeded',
    canceled: 'cancelled',
    error: 'failed',
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
        return asRecord(JSON.parse(trimmed));
    } catch {
        return null;
    }
}

/**
 * The `SubAgentRun` tool result is a structured payload (`SubAgentRunResultV2Schema`) whose
 * top-level `status` is written by the execution-run manager. Only that field is read.
 *
 * Compatibility, deliberately bounded: a result persisted as a JSON string (single top-level
 * parse, escaped-quote tolerant) is still understood. Nothing else is inspected — no regex over
 * prose and no walk into nested values, because a subagent writing about a status must never be
 * able to set the run's status.
 */
function readExecutionRunResultRecord(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record) return record;
    if (typeof result === 'string') return parseJsonObject(result.replaceAll('\\"', '"'));
    return null;
}

export function readExecutionRunResultStatus(result: unknown): ExecutionRunStatus | null {
    const status = readExecutionRunResultRecord(result)?.status;
    if (typeof status !== 'string') return null;
    const normalized = status.trim().toLowerCase();
    if (EXECUTION_RUN_STATUSES.has(normalized)) return normalized as ExecutionRunStatus;
    return LEGACY_EXECUTION_RUN_STATUS_ALIASES[normalized] ?? null;
}

export function mapExecutionRunStatusToSubagentStatus(status: ExecutionRunStatus): SessionSubagentStatus {
    switch (status) {
        case 'running':
            return 'running';
        case 'succeeded':
            return 'succeeded';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        // A timed-out run is neither a success (it produced nothing) nor a plain failure
        // (the recovery is a larger budget, not reading an error).
        case 'timeout':
            return 'timedOut';
    }
}

export function mapSubagentStatusToExecutionRunStatus(status: SessionSubagentStatus): ExecutionRunStatus | null {
    switch (status) {
        case 'running':
            return 'running';
        case 'succeeded':
            return 'succeeded';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        case 'timedOut':
            return 'timeout';
        // Not execution-run outcomes: `terminated` belongs to the Claude teammate vocabulary and
        // `unknown` means the transcript never carried a status.
        case 'terminated':
        case 'unknown':
            return null;
    }
}

export function isTerminalSubagentStatus(status: SessionSubagentStatus): boolean {
    return status === 'succeeded'
        || status === 'failed'
        || status === 'timedOut'
        || status === 'cancelled'
        || status === 'terminated';
}

/**
 * A `SubAgentRun` call the parent turn interrupted leaves an abort placeholder rather than a run
 * outcome; it is ambiguous, not failed, so external/liveness evidence may still upgrade it.
 */
function valueHasRequestInterruptedSignal(value: unknown, depth = 0): boolean {
    if (depth > 5 || value == null) return false;
    if (typeof value === 'string') return value.replaceAll('\\"', '"').toLowerCase().includes('request interrupted');
    if (Array.isArray(value)) return value.some((item) => valueHasRequestInterruptedSignal(item, depth + 1));
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some((item) => valueHasRequestInterruptedSignal(item, depth + 1));
    }
    return false;
}

export function deriveTranscriptExecutionRunStatus(tool: ToolCall): SessionSubagentStatus {
    const resultStatus = readExecutionRunResultStatus(tool.result);
    if (tool.state === 'running' || resultStatus === 'running') return 'running';
    if (resultStatus) return mapExecutionRunStatusToSubagentStatus(resultStatus);
    if (tool.state === 'error') return valueHasRequestInterruptedSignal(tool.result) ? 'unknown' : 'failed';
    if (tool.state === 'completed') return 'succeeded';
    return 'unknown';
}
