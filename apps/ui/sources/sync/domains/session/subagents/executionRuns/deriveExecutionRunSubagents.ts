import type { Message } from '@/sync/domains/messages/messageTypes';
import { canSendMessagesToExecutionRun } from '@/sync/domains/executionRuns/canSendMessagesToExecutionRun';

import type { SessionSubagent, SessionSubagentActiveExecutionRunState, SessionSubagentStatus } from '../types';
import {
    deriveTranscriptExecutionRunStateIndex,
    resolveTranscriptBackendLabel,
} from './deriveTranscriptExecutionRunStateIndex';
import { isTerminalSubagentStatus } from './executionRunSubagentStatus';
import {
    extractExecutionRunIdsFromAgentText,
    looksLikeExecutionRunStartText,
} from './executionRunTranscriptSignals';

/**
 * Projects execution runs into the shared roster model.
 *
 * The transcript half lives in `deriveTranscriptExecutionRunStateIndex`; this module owns only the
 * merge with live registry state and the resulting `SessionSubagent`. Splitting them is what keeps
 * the liveness ordering below readable — it is the single place run status is decided, and §4.9.3
 * makes that ordering a contract rather than an implementation detail.
 */
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
        for (const runId of extractExecutionRunIdsFromAgentText(text)) {
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
        // Liveness authority, strongest first: an explicit stop, then the run registry (structured,
        // live), then the transcript's own terminal evidence, and only then the agent's prose. Prose
        // may recover a run whose transcript state is ambiguous (an interrupted call), never
        // resurrect one the transcript already reports as finished.
        const hasTerminalTranscriptEvidence = transcriptState ? isTerminalSubagentStatus(transcriptState.status) : false;
        const isLive =
            runningFromExternal.has(runId)
            || (runningFromAgentText.has(runId) && !hasTerminalTranscriptEvidence);
        const effectiveStatus: SessionSubagentStatus =
            explicitlyStoppedRunIds.has(runId)
                ? 'cancelled'
                : (
            isLive
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
