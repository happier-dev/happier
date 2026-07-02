import type { StreamedTranscriptFlushSummary } from '@/api/session/streamedTranscriptWriter';
import type { ClaudeCompletionEvent } from '@/backends/claude/contextCompactionEvents';
import { createClaudeAgentSdkProviderActivityLedger } from './createClaudeAgentSdkProviderActivityLedger';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

export function createClaudeAgentSdkTurnLifecycle(params: {
    flushStreamedTranscriptWriter: (
        reason: FlushReason,
        interruptedReason?: string,
    ) => Promise<StreamedTranscriptFlushSummary | null>;
    updateThinking: (thinking: boolean) => void;
    onReady: () => void | Promise<void>;
    onSubagentFlush?: () => void | Promise<void>;
    onCompletionEvent?: ((message: ClaudeCompletionEvent) => void) | undefined;
    noteDurableAssistantFlush: (summary: StreamedTranscriptFlushSummary | null) => void;
    getTurnDiagnostics: () => Record<string, unknown>;
    getDidPublishAssistantTextThisTurn: () => boolean;
    scheduleNextMessagePump: () => void;
    clearActiveTask: () => void;
    consumeDeferredInterruptedReason: () => string | null;
    logTurnSummary: (summary: Record<string, unknown>) => void;
}) {
    let lastTurnFlushSummary: StreamedTranscriptFlushSummary | null = null;
    const inboundDiagnostics = {
        streamEventCount: 0,
        assistantMessageCount: 0,
        userMessageCount: 0,
        resultMessageCount: 0,
        systemMessageCount: 0,
        unknownMessageCount: 0,
    };
    let didFinalizeTurn = false;
    let awaitingNextTurnStart = false;
    let didPushQueuedPromptAfterFinalizedTurn = false;
    let didReleaseTurnForResult = false;
    let pendingResultReleaseForActiveProviderTasks = false;
    const providerActivityLedger = createClaudeAgentSdkProviderActivityLedger();

    const resetInboundDiagnostics = () => {
        inboundDiagnostics.streamEventCount = 0;
        inboundDiagnostics.assistantMessageCount = 0;
        inboundDiagnostics.userMessageCount = 0;
        inboundDiagnostics.resultMessageCount = 0;
        inboundDiagnostics.systemMessageCount = 0;
        inboundDiagnostics.unknownMessageCount = 0;
    };

    const hasActiveProviderTasks = () => providerActivityLedger.hasActiveProviderTasks();

    const releasePendingResultIfProviderTasksResolved = () => {
        if (!pendingResultReleaseForActiveProviderTasks || hasActiveProviderTasks()) return;
        pendingResultReleaseForActiveProviderTasks = false;
        params.updateThinking(false);
    };

    const isProviderContinuationMessageAfterResult = (message: unknown, inboundType: string): boolean => {
        if (!didReleaseTurnForResult || pendingResultReleaseForActiveProviderTasks) return false;
        if (!message || typeof message !== 'object') return false;
        if (inboundType === 'assistant' || inboundType === 'user' || inboundType === 'stream_event') return true;
        if (inboundType !== 'system') return false;
        const subtype = (message as any).subtype;
        return (
            subtype === 'compact_boundary' ||
            subtype === 'compact_result' ||
            subtype === 'compact_metadata' ||
            subtype === 'task_started' ||
            subtype === 'task_progress' ||
            subtype === 'task_notification'
        );
    };

    const markProviderContinuationAfterResult = () => {
        didReleaseTurnForResult = false;
        lastTurnFlushSummary = null;
        resetInboundDiagnostics();
        params.updateThinking(true);
    };

    return {
        noteIncomingMessageBeforeDiagnostics: (message: unknown, inboundType: string) => {
            if (isProviderContinuationMessageAfterResult(message, inboundType)) {
                markProviderContinuationAfterResult();
            }
        },
        recordInboundType: (inboundType: string) => {
            if (inboundType === 'stream_event') {
                inboundDiagnostics.streamEventCount += 1;
            } else if (inboundType === 'assistant') {
                inboundDiagnostics.assistantMessageCount += 1;
            } else if (inboundType === 'user') {
                inboundDiagnostics.userMessageCount += 1;
            } else if (inboundType === 'result') {
                inboundDiagnostics.resultMessageCount += 1;
            } else if (inboundType === 'system') {
                inboundDiagnostics.systemMessageCount += 1;
            } else {
                inboundDiagnostics.unknownMessageCount += 1;
            }
        },
        prepareForQueuedPrompt: () => {
            lastTurnFlushSummary = null;
            didReleaseTurnForResult = false;
            if (awaitingNextTurnStart && didFinalizeTurn) {
                didPushQueuedPromptAfterFinalizedTurn = true;
            }
        },
        onTurnStartBoundary: () => {
            if (awaitingNextTurnStart && didFinalizeTurn && didPushQueuedPromptAfterFinalizedTurn) {
                awaitingNextTurnStart = false;
                didFinalizeTurn = false;
                didPushQueuedPromptAfterFinalizedTurn = false;
            }
        },
        onPreparedIncomingMessage: (incomingMessageType: unknown) => {
            if (
                awaitingNextTurnStart &&
                didFinalizeTurn &&
                didPushQueuedPromptAfterFinalizedTurn &&
                (incomingMessageType === 'assistant' ||
                    incomingMessageType === 'user' ||
                    incomingMessageType === 'result')
            ) {
                awaitingNextTurnStart = false;
                didFinalizeTurn = false;
                didPushQueuedPromptAfterFinalizedTurn = false;
            }
        },
        finalizeCurrentTurn: async (options?: { completionEvent?: ClaudeCompletionEvent }) => {
            if (didFinalizeTurn) return;
            didFinalizeTurn = true;
            awaitingNextTurnStart = true;
            didPushQueuedPromptAfterFinalizedTurn = false;
            params.clearActiveTask();
            params.updateThinking(false);
            const interruptedReason = params.consumeDeferredInterruptedReason();
            if (typeof interruptedReason === 'string' && interruptedReason.trim().length > 0) {
                lastTurnFlushSummary = await params.flushStreamedTranscriptWriter('abort', interruptedReason);
            } else {
                lastTurnFlushSummary = await params.flushStreamedTranscriptWriter('turn-end');
            }
            params.noteDurableAssistantFlush(lastTurnFlushSummary);
            params.logTurnSummary({
                ...inboundDiagnostics,
                ...params.getTurnDiagnostics(),
                didPublishAssistantTextThisTurn: params.getDidPublishAssistantTextThisTurn(),
            });
            resetInboundDiagnostics();
            if (options?.completionEvent) {
                params.onCompletionEvent?.(options.completionEvent);
            }
            await params.onReady();
            params.scheduleNextMessagePump();
        },
        releaseCurrentTurnForResult: async () => {
            if (didFinalizeTurn || didReleaseTurnForResult) return;
            didReleaseTurnForResult = true;
            if (!hasActiveProviderTasks()) {
                params.clearActiveTask();
                params.updateThinking(false);
            } else {
                pendingResultReleaseForActiveProviderTasks = true;
            }
            lastTurnFlushSummary = await params.flushStreamedTranscriptWriter('turn-end');
            params.noteDurableAssistantFlush(lastTurnFlushSummary);
            params.logTurnSummary({
                ...inboundDiagnostics,
                ...params.getTurnDiagnostics(),
                didPublishAssistantTextThisTurn: params.getDidPublishAssistantTextThisTurn(),
                resultObserved: true,
                activeProviderTaskBlockers: providerActivityLedger.getActiveProviderTaskBlockers(),
                activeProviderTaskCount: providerActivityLedger.getActiveProviderTaskCount(),
                deferredCompletionForActiveProviderTasks: pendingResultReleaseForActiveProviderTasks,
            });
            resetInboundDiagnostics();
            await params.onReady();
            params.scheduleNextMessagePump();
        },
        finalizeSubagentTurn: async () => {
            lastTurnFlushSummary = await params.flushStreamedTranscriptWriter('turn-end');
            params.logTurnSummary({
                ...inboundDiagnostics,
                ...params.getTurnDiagnostics(),
                didPublishAssistantTextThisTurn: params.getDidPublishAssistantTextThisTurn(),
                subagentTurn: true,
            });
            resetInboundDiagnostics();
            await params.onSubagentFlush?.();
        },
        noteProviderTaskStarted: (taskId: unknown) => {
            providerActivityLedger.noteProviderTaskStarted(taskId);
        },
        noteProviderTaskProgress: (taskId: unknown) => {
            providerActivityLedger.noteProviderTaskProgress(taskId);
        },
        noteProviderTaskFinished: (taskId: unknown) => {
            providerActivityLedger.noteProviderTaskFinished(taskId);
            releasePendingResultIfProviderTasksResolved();
        },
        noteBackgroundProviderTask: (taskId: unknown) => {
            providerActivityLedger.noteBackgroundProviderTask(taskId);
        },
        noteNoActiveBackgroundProviderTasks: () => {
            providerActivityLedger.clearProviderTasks();
            releasePendingResultIfProviderTasksResolved();
        },
        isTurnFinalized: () => didFinalizeTurn,
        getLastTurnFlushSummary: () => lastTurnFlushSummary,
    };
}
