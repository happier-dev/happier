import {
    ExecutionRunClassSchema,
    ExecutionRunIntentSchema,
    ExecutionRunIoModeSchema,
    ExecutionRunRetentionPolicySchema,
    type BackendTargetRefV1,
    type ExecutionRunClass,
    type ExecutionRunIntent,
    type ExecutionRunIoMode,
    type ExecutionRunPublicState,
    type ExecutionRunRetentionPolicy,
} from '@happier-dev/protocol';

import {
    readOptionalString,
    type TranscriptExecutionRunState,
} from './deriveTranscriptExecutionRunStateIndex';
import { mapSubagentStatusToExecutionRunStatus } from './executionRunSubagentStatus';

/**
 * Reconstructs the wire-shaped `ExecutionRunPublicState` for a run the live registry no longer
 * serves, from what the transcript recorded about it.
 *
 * It is a *vocabulary translation*, which is why it is not part of the transcript index: the index
 * speaks the subagent vocabulary and the roster consumes it directly, while this speaks the
 * execution-run wire contract and exists for one detail surface. Every enum below is parsed by its
 * protocol schema rather than re-declared, so a value added to the contract is accepted here
 * without a lockstep edit — and an unknown value is refused rather than coerced.
 */
function normalizeEnumInput(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function readExecutionRunIntent(value: string | null | undefined): ExecutionRunIntent | null {
    const parsed = ExecutionRunIntentSchema.safeParse(normalizeEnumInput(value));
    return parsed.success ? parsed.data : null;
}

function readExecutionRunClass(value: string | null | undefined): ExecutionRunClass | null {
    const parsed = ExecutionRunClassSchema.safeParse(normalizeEnumInput(value));
    return parsed.success ? parsed.data : null;
}

function readExecutionRunIoMode(value: string | null | undefined): ExecutionRunIoMode | null {
    const parsed = ExecutionRunIoModeSchema.safeParse(normalizeEnumInput(value));
    return parsed.success ? parsed.data : null;
}

function readExecutionRunRetentionPolicy(value: string | null | undefined): ExecutionRunRetentionPolicy | null {
    const parsed = ExecutionRunRetentionPolicySchema.safeParse(normalizeEnumInput(value));
    return parsed.success ? parsed.data : null;
}

export function buildExecutionRunPublicStateFromTranscriptState(
    state: TranscriptExecutionRunState,
): ExecutionRunPublicState | null {
    const intent = readExecutionRunIntent(state.intent);
    const backendTarget = state.backendTarget ?? (state.backendId ? { kind: 'builtInAgent', agentId: state.backendId } satisfies BackendTargetRefV1 : null);
    const runClass = readExecutionRunClass(state.runClass);
    // Inference kept from the transcript-only reconstruction: a long-lived run streams, a bounded
    // one is request/response, and the same split decides retention below.
    const ioMode = readExecutionRunIoMode(state.ioMode)
        ?? (runClass === 'long_lived' ? 'streaming' : 'request_response');
    // The transcript state speaks the subagent vocabulary; the public state speaks the wire one,
    // so the mapping is explicit (and a timed-out run stays timed out instead of being dropped).
    const status = mapSubagentStatusToExecutionRunStatus(state.status);
    const callId = readOptionalString({ callId: state.toolId }, 'callId') ?? readOptionalString({ callId: state.sidechainId }, 'callId');
    const sidechainId = readOptionalString({ sidechainId: state.sidechainId }, 'sidechainId') ?? callId;
    if (!intent || !backendTarget || !runClass || !ioMode || !status || !callId || !sidechainId) return null;

    const retentionPolicy = readExecutionRunRetentionPolicy(state.retentionPolicy)
        ?? (runClass === 'long_lived' ? 'resumable' : 'ephemeral');
    const permissionMode = readOptionalString({ permissionMode: state.permissionMode }, 'permissionMode') ?? 'unknown';

    return {
        runId: state.runId,
        callId,
        sidechainId,
        intent,
        backendTarget,
        ...(state.displayLabel ? { display: { title: state.displayLabel } } : {}),
        permissionMode,
        retentionPolicy,
        runClass,
        ioMode,
        status,
        // Never `?? state.updatedAtMs ?? state.finishedAtMs`: a start borrowed from the last update —
        // or from the end, which reports the run as having taken zero time — is a fabrication that
        // renders as a recorded fact (D-8). The wire field is required, so 0 is the unknown sentinel
        // and the detail card guards on `> 0`.
        startedAtMs: state.startedAtMs ?? 0,
        ...(typeof state.finishedAtMs === 'number' ? { finishedAtMs: state.finishedAtMs } : {}),
    };
}
