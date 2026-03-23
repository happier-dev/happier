import type { BackendTargetRefV1, ExecutionRunPublicState } from '@happier-dev/protocol';

import type { Message, ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import { canSendMessagesToExecutionRun } from '@/sync/domains/executionRuns/canSendMessagesToExecutionRun';
import { readExecutionRunIdFromToolPayload } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { toolNameLooksLikeExecutionRunStop } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';

import type { SessionSubagent, SessionSubagentActiveExecutionRunState, SessionSubagentStatus } from '../types';

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

const EXECUTION_RUN_INTENTS = new Set(['review', 'plan', 'delegate', 'voice_agent', 'memory_hints']);
const EXECUTION_RUN_CLASSES = new Set(['bounded', 'long_lived']);
const EXECUTION_RUN_IO_MODES = new Set(['request_response', 'streaming']);
const EXECUTION_RUN_STATUSES = new Set(['running', 'succeeded', 'failed', 'cancelled', 'timeout']);
const EXECUTION_RUN_RETENTION_POLICIES = new Set(['ephemeral', 'resumable']);

function normalizeEmbeddedJsonString(value: string): string {
    return value.replaceAll('\\"', '"');
}

function safeParseObjectFromString(value: string): Record<string, unknown> | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // Ignore malformed embedded JSON.
    }
    return null;
}

function readResultStatus(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === 'string') {
        const normalized = normalizeEmbeddedJsonString(value);
        const parsed = safeParseObjectFromString(normalized);
        if (parsed) return readResultStatus(parsed);
        const directMatch = normalized.match(/\bstatus\s*:\s*"?([a-z_]+)"?/i);
        return directMatch ? String(directMatch[1]).trim().toLowerCase() : null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const status = readResultStatus(item);
            if (status) return status;
        }
        return null;
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const directStatus = typeof record.status === 'string' ? String(record.status).trim().toLowerCase() : '';
        if (directStatus) return directStatus;
        for (const item of Object.values(record)) {
            const status = readResultStatus(item);
            if (status) return status;
        }
    }
    return null;
}

function valueHasRequestInterruptedSignal(value: unknown, depth = 0): boolean {
    if (depth > 5 || value == null) return false;
    if (typeof value === 'string') return normalizeEmbeddedJsonString(value).toLowerCase().includes('request interrupted');
    if (Array.isArray(value)) return value.some((item) => valueHasRequestInterruptedSignal(item, depth + 1));
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some((item) => valueHasRequestInterruptedSignal(item, depth + 1));
    }
    return false;
}

function deriveTranscriptExecutionRunStatus(tool: ToolCall): SessionSubagentStatus {
    const resultStatus = readResultStatus(tool.result);
    if (tool.state === 'running' || resultStatus === 'running') return 'running';
    if (resultStatus === 'succeeded' || resultStatus === 'completed') return 'succeeded';
    if (resultStatus === 'cancelled' || resultStatus === 'canceled') return 'cancelled';
    if (resultStatus === 'failed' || resultStatus === 'error') return 'failed';
    if (tool.state === 'error') return valueHasRequestInterruptedSignal(tool.result) ? 'unknown' : 'failed';
    if (tool.state === 'completed') return 'succeeded';
    return 'unknown';
}

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

function looksLikeExecutionRunStartText(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
        normalized.includes('execution run has been started')
        || normalized.includes('execution run started')
        || normalized.includes('run has been started')
        || normalized.includes('new long-lived execution run started')
        || normalized.includes('bounded execution run started')
    );
}

function extractExecutionRunIdsFromText(text: string): readonly string[] {
    const directMatches = text.match(/run_[0-9a-z-]{8,}/gi) ?? [];
    return Array.from(new Set(directMatches.map((value) => value.trim())));
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
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

function resolveTranscriptBackendLabel(state: TranscriptExecutionRunState): string | null {
    if (state.backendTarget?.kind === 'builtInAgent') return state.backendTarget.agentId;
    if (state.backendTarget?.kind === 'configuredAcpBackend') return state.backendTarget.backendId;
    return state.backendId ?? null;
}

function valueHasOkTrueSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"');
        return /"ok"\s*:\s*true/i.test(normalized) || /\bok\s*:\s*true\b/i.test(normalized);
    }

    if (Array.isArray(value)) {
        return value.some((item) => valueHasOkTrueSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (record.ok === true) return true;
        return Object.values(record).some((item) => valueHasOkTrueSignal(item, depth + 1));
    }

    return false;
}

function valueHasExecutionRunNotRunningSignal(value: unknown, depth = 0): boolean {
    if (depth > 4 || value == null) return false;

    if (typeof value === 'string') {
        const normalized = value.replaceAll('\\"', '"');
        return (
            /\berrorCode\s*:\s*"?execution_run_not_allowed"?/i.test(normalized)
            || /\berrorCode\s*:\s*"?execution_run_not_running"?/i.test(normalized)
            || /\bnot running\b/i.test(normalized)
            || /\balready finished\b/i.test(normalized)
        );
    }

    if (Array.isArray(value)) {
        return value.some((item) => valueHasExecutionRunNotRunningSignal(item, depth + 1));
    }

    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const errorCode = typeof record.errorCode === 'string' ? String(record.errorCode).trim().toLowerCase() : '';
        if (errorCode === 'execution_run_not_allowed' || errorCode === 'execution_run_not_running') return true;

        const error = typeof record.error === 'string' ? String(record.error).trim().toLowerCase() : '';
        if (error.includes('not running') || error.includes('already finished')) return true;

        return Object.values(record).some((item) => valueHasExecutionRunNotRunningSignal(item, depth + 1));
    }

    return false;
}

function deriveExplicitlyStoppedExecutionRunIds(messages: readonly Message[]): ReadonlySet<string> {
    const stoppedRunIds = new Set<string>();
    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        if (!toolMessage.tool || toolMessage.tool.state !== 'completed') continue;
        if (!toolNameLooksLikeExecutionRunStop(toolMessage.tool.name)) continue;

        const runId = readExecutionRunIdFromToolPayload(toolMessage.tool);
        if (!runId) continue;
        if (!valueHasOkTrueSignal(toolMessage.tool.result) && !valueHasExecutionRunNotRunningSignal(toolMessage.tool.result)) continue;
        stoppedRunIds.add(runId);
    }
    return stoppedRunIds;
}

export function deriveExecutionRunSubagents(params: Readonly<{
    messages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
}>): readonly SessionSubagent[] {
    const { byRunId, explicitlyStoppedRunIds, orderedMessages } = deriveTranscriptExecutionRunStateIndex(params.messages);

    const runningFromAgentText = new Set<string>();
    for (const message of orderedMessages) {
        if (!message || message.kind !== 'agent-text') continue;
        const text = typeof (message as any).text === 'string' ? String((message as any).text).trim() : '';
        if (!text || !looksLikeExecutionRunStartText(text)) continue;
        for (const runId of extractExecutionRunIdsFromText(text)) {
            if (byRunId.has(runId) && !explicitlyStoppedRunIds.has(runId)) runningFromAgentText.add(runId);
        }
    }

    const runningFromExternal = new Set<string>();
    for (const run of params.activeExecutionRuns ?? []) {
        if (!run || typeof run !== 'object') continue;
        const runId = typeof run.runId === 'string' ? run.runId.trim() : '';
        const status = typeof run.status === 'string' ? run.status.trim().toLowerCase() : '';
        if (!runId || status !== 'running' || explicitlyStoppedRunIds.has(runId)) continue;
        runningFromExternal.add(runId);
    }

    const allRunIds = new Set<string>([
        ...byRunId.keys(),
        ...runningFromAgentText.values(),
        ...runningFromExternal.values(),
    ]);

    return Array.from(allRunIds.values()).map((runId) => {
        const transcriptState = byRunId.get(runId);
        const effectiveStatus: SessionSubagentStatus =
            explicitlyStoppedRunIds.has(runId)
                ? 'cancelled'
                : (
            runningFromExternal.has(runId) || runningFromAgentText.has(runId)
                ? 'running'
                : transcriptState?.status ?? 'unknown'
                );
        const displayTitle = transcriptState?.displayLabel ?? runId;
        const canOpen = Boolean(transcriptState?.sidechainId);
        const canSend = canSendMessagesToExecutionRun({
            status: effectiveStatus,
            intent: transcriptState?.intent ?? null,
            runClass: transcriptState?.runClass ?? null,
        });
        const backendLabel = transcriptState ? resolveTranscriptBackendLabel(transcriptState) : null;

        return {
            id: `execution_run:${runId}`,
            kind: 'execution_run',
            status: effectiveStatus,
            display: {
                title: displayTitle,
                ...(transcriptState?.intent ? { subtitle: transcriptState.intent } : {}),
                ...(backendLabel ? { providerLabel: backendLabel } : {}),
            },
            transcript: {
                ...(transcriptState?.sidechainId ? { sidechainId: transcriptState.sidechainId } : {}),
                ...(transcriptState?.toolMessageRouteId ? { toolMessageRouteId: transcriptState.toolMessageRouteId } : {}),
                ...(transcriptState?.toolId ? { toolId: transcriptState.toolId } : {}),
            },
            runRef: {
                runId,
                ...(backendLabel ? { backendId: backendLabel } : {}),
                ...(transcriptState?.intent ? { intent: transcriptState.intent } : {}),
                ...(transcriptState?.runClass ? { runClass: transcriptState.runClass } : {}),
                ...(transcriptState?.ioMode ? { ioMode: transcriptState.ioMode } : {}),
            },
            recipient: canSend
                ? {
                    kind: 'execution_run',
                    runId,
                    ...(transcriptState?.displayLabel ? { label: transcriptState.displayLabel } : {}),
                }
                : null,
            capabilities: {
                canOpen,
                canSend,
                canStop: effectiveStatus === 'running',
                canLaunchChild: false,
                canDelete: false,
                canOpenAdvancedRun: true,
            },
            timestamps: {
                ...(transcriptState?.startedAtMs ? { startedAtMs: transcriptState.startedAtMs } : {}),
                ...(transcriptState?.updatedAtMs ? { updatedAtMs: transcriptState.updatedAtMs } : {}),
                ...(transcriptState?.finishedAtMs ? { finishedAtMs: transcriptState.finishedAtMs } : {}),
            },
        } satisfies SessionSubagent;
    });
}

function deriveTranscriptExecutionRunStateIndex(messages: readonly Message[]): Readonly<{
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

function readValidExecutionRunString(
    value: string | null | undefined,
    allowedValues: ReadonlySet<string>,
): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) return null;
    return allowedValues.has(normalized) ? normalized : null;
}

export function buildExecutionRunPublicStateFromTranscriptState(
    state: TranscriptExecutionRunState,
): ExecutionRunPublicState | null {
    const intent = readValidExecutionRunString(state.intent ?? null, EXECUTION_RUN_INTENTS);
    const backendTarget = state.backendTarget ?? (state.backendId ? { kind: 'builtInAgent', agentId: state.backendId } satisfies BackendTargetRefV1 : null);
    const runClass = readValidExecutionRunString(state.runClass ?? null, EXECUTION_RUN_CLASSES);
    const ioMode = readValidExecutionRunString(state.ioMode ?? null, EXECUTION_RUN_IO_MODES)
        ?? (runClass === 'long_lived' ? 'streaming' : 'request_response');
    const status = readValidExecutionRunString(state.status ?? null, EXECUTION_RUN_STATUSES);
    const callId = readOptionalString({ callId: state.toolId }, 'callId') ?? readOptionalString({ callId: state.sidechainId }, 'callId');
    const sidechainId = readOptionalString({ sidechainId: state.sidechainId }, 'sidechainId') ?? callId;
    if (!intent || !backendTarget || !runClass || !ioMode || !status || !callId || !sidechainId) return null;

    const retentionPolicy = readValidExecutionRunString(state.retentionPolicy ?? null, EXECUTION_RUN_RETENTION_POLICIES)
        ?? readValidExecutionRunString(runClass === 'long_lived' ? 'resumable' : 'ephemeral', EXECUTION_RUN_RETENTION_POLICIES)
        ?? 'ephemeral';
    const permissionMode = readOptionalString({ permissionMode: state.permissionMode }, 'permissionMode') ?? 'unknown';

    return {
        runId: state.runId,
        callId,
        sidechainId,
        intent: intent as ExecutionRunPublicState['intent'],
        backendTarget,
        ...(state.displayLabel ? { display: { title: state.displayLabel } } : {}),
        permissionMode,
        retentionPolicy: retentionPolicy as ExecutionRunPublicState['retentionPolicy'],
        runClass: runClass as ExecutionRunPublicState['runClass'],
        ioMode: ioMode as ExecutionRunPublicState['ioMode'],
        status: status as ExecutionRunPublicState['status'],
        startedAtMs: state.startedAtMs ?? state.updatedAtMs ?? state.finishedAtMs ?? 0,
        ...(typeof state.finishedAtMs === 'number' ? { finishedAtMs: state.finishedAtMs } : {}),
    };
}
