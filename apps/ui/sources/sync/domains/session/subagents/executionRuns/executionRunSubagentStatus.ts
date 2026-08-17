import { ExecutionRunStatusSchema, type ExecutionRunStatus } from '@happier-dev/protocol';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

import type { SessionSubagentStatus } from '../types';

/**
 * The single owner of "what is this execution run's status, and was its call interrupted?".
 *
 * Before this module the question had four answers in the UI: the roster derivation, the
 * auto-recipient resolver, the `SubAgentRun` renderer and the subagent-source-message signature in
 * the store. They disagreed — an interrupted call was ambiguous to the roster and terminal to the
 * composer's routing — and the disagreement was silent.
 */

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
 * The `SubAgentRun` tool result is a structured payload whose top-level `status` is written by the
 * execution-run manager. Only that field is read.
 *
 * Compatibility, deliberately bounded: a result persisted as a JSON string (single top-level parse,
 * escaped-quote tolerant) is still understood. Nothing else is inspected — no regex over prose and
 * no walk into nested values, because a subagent writing *about* a status must never be able to set
 * the run's status.
 */
function readExecutionRunResultRecord(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record) return record;
    if (typeof result === 'string') return parseJsonObject(result.replaceAll('\\"', '"'));
    return null;
}

/**
 * The status vocabulary is owned by the protocol schema, never re-declared here: a new member is
 * accepted without a lockstep edit, and the mappings below stop compiling until it is given an
 * explicit presentation meaning.
 */
export function readExecutionRunResultStatus(result: unknown): ExecutionRunStatus | null {
    const status = readExecutionRunResultRecord(result)?.status;
    if (typeof status !== 'string') return null;
    const normalized = status.trim().toLowerCase();
    const parsed = ExecutionRunStatusSchema.safeParse(normalized);
    if (parsed.success) return parsed.data;
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
 *
 * Exported because the renderer needs the same answer: `SubAgentRunView` shows the still-streaming
 * sidechain instead of an error card for exactly these results, and it carried its own copy of this
 * walk. Two copies of "is this an interruption?" is two places for the marker string, the escaped
 * quotes and the depth bound to drift, and the failure would be silent — an interrupted run quietly
 * rendering as failed on one surface and as running on the other.
 */
export function valueHasRequestInterruptedSignal(value: unknown, depth = 0): boolean {
    if (depth > 5 || value == null) return false;
    if (typeof value === 'string') return value.replaceAll('\\"', '"').toLowerCase().includes('request interrupted');
    if (Array.isArray(value)) return value.some((item) => valueHasRequestInterruptedSignal(item, depth + 1));
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some((item) => valueHasRequestInterruptedSignal(item, depth + 1));
    }
    return false;
}

/**
 * Ordering is the whole contract here, and each step earns its place:
 *
 * 1. Liveness first, so a run still reporting `running` is never read as finished.
 * 2. The execution-run manager's own `status`, which is the only *reported outcome* there is. It
 *    deliberately outranks the interruption check below: a run that reported `succeeded` while the
 *    parent call was being torn down is terminal, and letting the marker downgrade it to ambiguous
 *    would re-open the routing that an agent's start announcement could then resurrect.
 * 3. The interruption marker, which is checked for *both* settled lifecycle states. Which of the two
 *    the aborted call lands in is an accident of when the interrupt arrived relative to the tool
 *    result, so reading `completed` as a run outcome invents a success the run never reported —
 *    exactly the absent value this vocabulary exists to keep absent.
 * 4. Only then the bare tool lifecycle, which is the weakest evidence and says nothing about the run.
 */
export function deriveTranscriptExecutionRunStatus(tool: ToolCall): SessionSubagentStatus {
    const resultStatus = readExecutionRunResultStatus(tool.result);
    if (tool.state === 'running' || resultStatus === 'running') return 'running';
    if (resultStatus) return mapExecutionRunStatusToSubagentStatus(resultStatus);
    if (valueHasRequestInterruptedSignal(tool.result)) return 'unknown';
    if (tool.state === 'error') return 'failed';
    if (tool.state === 'completed') return 'succeeded';
    return 'unknown';
}
