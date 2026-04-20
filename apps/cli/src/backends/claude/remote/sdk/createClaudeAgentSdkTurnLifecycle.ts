import type { StreamedTranscriptFlushSummary } from '@/api/session/streamedTranscriptWriter';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

export function createClaudeAgentSdkTurnLifecycle(params: {
    flushStreamedTranscriptWriter: (
        reason: FlushReason,
        interruptedReason?: string,
    ) => Promise<StreamedTranscriptFlushSummary | null>;
    updateThinking: (thinking: boolean) => void;
    onReady: () => void | Promise<void>;
    onCompletionEvent?: ((message: string) => void) | undefined;
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

    const resetInboundDiagnostics = () => {
        inboundDiagnostics.streamEventCount = 0;
        inboundDiagnostics.assistantMessageCount = 0;
        inboundDiagnostics.userMessageCount = 0;
        inboundDiagnostics.resultMessageCount = 0;
        inboundDiagnostics.systemMessageCount = 0;
        inboundDiagnostics.unknownMessageCount = 0;
    };

    return {
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
        finalizeCurrentTurn: async (options?: { completionEvent?: string }) => {
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
        isTurnFinalized: () => didFinalizeTurn,
        getLastTurnFlushSummary: () => lastTurnFlushSummary,
    };
}
