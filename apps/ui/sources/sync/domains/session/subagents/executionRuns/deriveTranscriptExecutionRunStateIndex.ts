import { ExecutionRunLaunchOriginSchema, type BackendTargetRefV1, type ExecutionRunLaunchOrigin } from '@happier-dev/protocol';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import { readExecutionRunIdFromToolPayload } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';

import {
    readToolCallFinishedAtMs,
    readToolCallObservedAtMs,
    readToolCallStartedAtMs,
} from '../toolCallActivityTimestamps';
import type { SessionSubagentStatus } from '../types';
import { deriveTranscriptExecutionRunStatus } from './executionRunSubagentStatus';
import { deriveExplicitlyStoppedExecutionRuns } from './executionRunTranscriptSignals';

/**
 * What the transcript alone knows about an execution run.
 *
 * This module answers one question — *what did the message stream say about run X?* — and nothing
 * about how a run is presented (`deriveExecutionRunSubagents`) or how it is expressed on the wire
 * (`executionRunPublicStateFromTranscript`). Keeping the three apart matters because they have
 * different authorities: the index is transcript truth, the roster merges it with the live run
 * registry, and the public state speaks a different vocabulary again.
 */
export type TranscriptExecutionRunState = {
    runId: string;
    status: SessionSubagentStatus;
    displayLabel?: string;
    toolMessageRouteId?: string;
    toolId?: string;
    sidechainId?: string;
    backendTarget?: BackendTargetRefV1 | null;
    backendId?: string | null;
    intent?: string | null;
    permissionMode?: string | null;
    retentionPolicy?: string | null;
    runClass?: string | null;
    ioMode?: string | null;
    launchOrigin?: ExecutionRunLaunchOrigin | null;
    startedAtMs?: number;
    updatedAtMs?: number;
    finishedAtMs?: number;
};

export type TranscriptExecutionRunStateIndex = Readonly<{
    byRunId: Map<string, TranscriptExecutionRunState>;
    /** Keyed by run id; the value is the stop call's own finish instant, or `null` when unknown. */
    explicitlyStoppedRunIds: ReadonlyMap<string, number | null>;
    orderedMessages: readonly Message[];
}>;

function sortMessagesChronologically(messages: readonly Message[]): readonly Message[] {
    return [...messages]
        .map((message, index) => ({ message, index }))
        .sort((left, right) => {
            const leftSeq = typeof (left.message as any)?.seq === 'number' ? Number((left.message as any).seq) : null;
            const rightSeq = typeof (right.message as any)?.seq === 'number' ? Number((right.message as any).seq) : null;
            if (leftSeq != null && rightSeq != null && leftSeq !== rightSeq) return leftSeq - rightSeq;

            const leftCreatedAt = typeof (left.message as any)?.createdAt === 'number' ? Number((left.message as any).createdAt) : null;
            const rightCreatedAt = typeof (right.message as any)?.createdAt === 'number' ? Number((right.message as any).createdAt) : null;
            if (leftCreatedAt != null && rightCreatedAt != null && leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;

            return left.index - right.index;
        })
        .map((entry) => entry.message);
}

export function readOptionalString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBackendTargetRef(value: unknown): BackendTargetRefV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind === 'builtInAgent' && typeof record.agentId === 'string' && record.agentId.trim().length > 0) {
        return { kind: 'builtInAgent', agentId: record.agentId.trim() };
    }
    if (record.kind === 'configuredAcpBackend' && typeof record.backendId === 'string' && record.backendId.trim().length > 0) {
        return { kind: 'configuredAcpBackend', backendId: record.backendId.trim() };
    }
    return null;
}

function readLaunchOrigin(value: unknown): ExecutionRunLaunchOrigin | null {
    const parsed = ExecutionRunLaunchOriginSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function readTranscriptBackendTarget(params: Readonly<{
    inputRecord: Record<string, unknown>;
    resultRecord: Record<string, unknown>;
    current?: TranscriptExecutionRunState | undefined;
}>): BackendTargetRefV1 | null {
    return (
        readBackendTargetRef(params.inputRecord.backendTarget)
        ?? readBackendTargetRef(params.resultRecord.backendTarget)
        ?? params.current?.backendTarget
        ?? (() => {
            const legacyBackendId =
                readOptionalString(params.inputRecord, 'backendId')
                ?? readOptionalString(params.resultRecord, 'backendId')
                ?? params.current?.backendId
                ?? null;
            return legacyBackendId ? { kind: 'builtInAgent', agentId: legacyBackendId } satisfies BackendTargetRefV1 : null;
        })()
    );
}

export function resolveTranscriptBackendLabel(state: TranscriptExecutionRunState): string | null {
    if (state.backendTarget?.kind === 'builtInAgent') return state.backendTarget.agentId;
    if (state.backendTarget?.kind === 'configuredAcpBackend') return state.backendTarget.backendId;
    return state.backendId ?? null;
}

export function deriveTranscriptExecutionRunStateIndex(messages: readonly Message[]): TranscriptExecutionRunStateIndex {
    const byRunId = new Map<string, TranscriptExecutionRunState>();
    const orderedMessages = sortMessagesChronologically(messages);
    const explicitlyStoppedRunIds = deriveExplicitlyStoppedExecutionRuns(messages);

    for (const message of orderedMessages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        if (toolMessage.tool?.name !== 'SubAgentRun') continue;

        const runId = readExecutionRunIdFromToolPayload(toolMessage.tool);
        if (!runId) continue;

        const inputRecord = toolMessage.tool.input && typeof toolMessage.tool.input === 'object'
            ? (toolMessage.tool.input as Record<string, unknown>)
            : {};
        const resultRecord = toolMessage.tool.result && typeof toolMessage.tool.result === 'object' && !Array.isArray(toolMessage.tool.result)
            ? (toolMessage.tool.result as Record<string, unknown>)
            : {};
        const status = deriveTranscriptExecutionRunStatus(toolMessage.tool);
        const current = byRunId.get(runId);
        const sidechainId = resolveToolTranscriptSidechainId({ tool: toolMessage.tool, normalizedToolName: 'SubAgentRun' }) ?? current?.sidechainId;
        const displayLabel = readOptionalString(inputRecord, 'label')
            ?? readOptionalString(resultRecord, 'label')
            ?? current?.displayLabel;

        const nextStatus =
            status === 'unknown' && current?.status === 'running'
                ? 'running'
                : status;
        const isExplicitlyStopped = explicitlyStoppedRunIds.has(runId);
        // The first observation owns the start: a later call for the same run would otherwise move
        // the start forward and shrink an elapsed value that has already been shown.
        const startedAtMs = current?.startedAtMs ?? readToolCallStartedAtMs(toolMessage) ?? undefined;
        const observedFinishAtMs = readToolCallFinishedAtMs(toolMessage);
        const finishedAtMs = isExplicitlyStopped
            // A stopped run's own call is often still `running` and carries no finish; the stop call
            // that ended it is then the only genuine terminal evidence there is.
            ? (observedFinishAtMs ?? explicitlyStoppedRunIds.get(runId) ?? current?.finishedAtMs)
            : (nextStatus === 'running' ? undefined : (observedFinishAtMs ?? current?.finishedAtMs));
        byRunId.set(runId, {
            runId,
            status: isExplicitlyStopped ? 'cancelled' : nextStatus,
            displayLabel: displayLabel ?? undefined,
            toolMessageRouteId: message.id,
            toolId: typeof toolMessage.tool.id === 'string' ? toolMessage.tool.id.trim() : current?.toolId,
            sidechainId: sidechainId ?? undefined,
            backendTarget: readTranscriptBackendTarget({ inputRecord, resultRecord, current }),
            backendId: readOptionalString(inputRecord, 'backendId') ?? readOptionalString(resultRecord, 'backendId') ?? current?.backendId ?? null,
            intent: readOptionalString(inputRecord, 'intent') ?? readOptionalString(resultRecord, 'intent') ?? current?.intent ?? null,
            permissionMode: readOptionalString(inputRecord, 'permissionMode') ?? readOptionalString(resultRecord, 'permissionMode') ?? current?.permissionMode ?? null,
            retentionPolicy: readOptionalString(inputRecord, 'retentionPolicy') ?? readOptionalString(resultRecord, 'retentionPolicy') ?? current?.retentionPolicy ?? null,
            runClass: readOptionalString(inputRecord, 'runClass') ?? readOptionalString(resultRecord, 'runClass') ?? current?.runClass ?? null,
            ioMode: readOptionalString(inputRecord, 'ioMode') ?? readOptionalString(resultRecord, 'ioMode') ?? current?.ioMode ?? null,
            launchOrigin: readLaunchOrigin(inputRecord.launchOrigin) ?? readLaunchOrigin(resultRecord.launchOrigin) ?? current?.launchOrigin ?? null,
            startedAtMs,
            updatedAtMs: readToolCallObservedAtMs(toolMessage) ?? current?.updatedAtMs,
            finishedAtMs,
        });
    }

    return {
        byRunId,
        explicitlyStoppedRunIds,
        orderedMessages,
    };
}

export function findTranscriptExecutionRunState(
    messages: readonly Message[],
    runId: string,
): TranscriptExecutionRunState | null {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return null;
    const { byRunId } = deriveTranscriptExecutionRunStateIndex(messages);
    return byRunId.get(normalizedRunId) ?? null;
}
