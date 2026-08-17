import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { readExecutionRunIdFromToolPayload } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';

import type { SessionSubagentStatus } from '../types';
import { deriveTranscriptExecutionRunStatus } from './executionRunSubagentStatus';
import { deriveExplicitlyStoppedExecutionRunIds } from './executionRunTranscriptSignals';

/**
 * What the transcript alone knows about each execution run.
 *
 * Kept apart from the roster projection (`deriveExecutionRunSubagents`) so the liveness ordering
 * there stays readable: this module reads tool calls, that one merges the result with live registry
 * state and decides the status a person sees.
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
    startedAtMs?: number;
    updatedAtMs?: number;
    finishedAtMs?: number;
};

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

export function deriveTranscriptExecutionRunStateIndex(messages: readonly Message[]): Readonly<{
    byRunId: Map<string, TranscriptExecutionRunState>;
    explicitlyStoppedRunIds: ReadonlySet<string>;
    orderedMessages: readonly Message[];
}> {
    const byRunId = new Map<string, TranscriptExecutionRunState>();
    const orderedMessages = sortMessagesChronologically(messages);
    const explicitlyStoppedRunIds = deriveExplicitlyStoppedExecutionRunIds(messages);

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
        byRunId.set(runId, {
            runId,
            status: explicitlyStoppedRunIds.has(runId) ? 'cancelled' : nextStatus,
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
            startedAtMs: typeof toolMessage.createdAt === 'number' ? toolMessage.createdAt : current?.startedAtMs,
            updatedAtMs: typeof toolMessage.createdAt === 'number' ? toolMessage.createdAt : current?.updatedAtMs,
            finishedAtMs: nextStatus === 'running' ? undefined : (typeof toolMessage.createdAt === 'number' ? toolMessage.createdAt : current?.finishedAtMs),
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
