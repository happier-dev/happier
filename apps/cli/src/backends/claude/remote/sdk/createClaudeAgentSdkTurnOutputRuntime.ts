import type { StreamedTranscriptFlushSummary, StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { SDKMessage } from '@/backends/claude/sdk';
import { logger } from '@/ui/logger';
import {
    extractTextDeltaFromStreamEvent,
    extractTextStartFromStreamEvent,
    extractThinkingDeltaFromStreamEvent,
    extractThinkingStartFromStreamEvent,
    extractToolResultStartFromStreamEvent,
    extractToolUseInputJsonDeltaFromStreamEvent,
    extractToolUseStartFromStreamEvent,
    isContentBlockStopStreamEvent,
    isMessageStopStreamEvent,
    messageContainsToolResultForToolUseId,
    messageContainsToolUseId,
    recordSeenToolBlocks,
    stripSeenToolBlocksFromMessage,
} from '@happier-dev/plugins-claude/agent/runtime/remote/sdk';

export type ClaudeAgentSdkTurnDiagnostics = {
    streamedTextDeltaChars: number;
    streamedThinkingDeltaChars: number;
    streamedToolUseDeltaChars: number;
    didPublishAssistantTextThisTurn: boolean;
    didDurablyFlushAssistantTextThisTurn: boolean;
};

type AssistantSegmentFlushSummary = { sawText: boolean; didDurablyFlush: boolean } | null;

type EmitAssistantTextMessageParams = {
    sessionId: string;
    parentToolUseId: string | null;
    assistantText: string;
    thinkingText?: string;
    defaultUuid?: string | null;
};

function normalizeSidechainIdForStream(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const raw = (message as any).parent_tool_use_id;
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function extractAssistantAndThinkingTextFromAssistantMessage(
    message: unknown,
): Readonly<{ assistantText: string | null; thinkingText: string | null }> {
    if (!message || typeof message !== 'object') return { assistantText: null, thinkingText: null };
    const incoming = message as any;
    if (incoming.type !== 'assistant') return { assistantText: null, thinkingText: null };
    const content = incoming?.message?.content;
    if (!Array.isArray(content)) return { assistantText: null, thinkingText: null };

    const assistantParts: string[] = [];
    const thinkingParts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof (block as any).text === 'string') {
            assistantParts.push(String((block as any).text));
        } else if (block.type === 'thinking' && typeof (block as any).thinking === 'string') {
            thinkingParts.push(String((block as any).thinking));
        }
    }

    const assistantText = assistantParts.join('');
    const thinkingText = thinkingParts.join('');
    return {
        assistantText: assistantText.trim().length > 0 ? assistantText : null,
        thinkingText: thinkingText.trim().length > 0 ? thinkingText : null,
    };
}

export function stripCoveredAssistantBlocks(params: Readonly<{
    message: SDKMessage;
    stripAssistantText: boolean;
    stripThinkingText: boolean;
}>): SDKMessage {
    if (params.message.type !== 'assistant') return params.message;
    const content = Array.isArray((params.message as any)?.message?.content)
        ? ((params.message as any).message.content as unknown[])
        : null;
    if (!content) return params.message;
    if (!params.stripAssistantText && !params.stripThinkingText) return params.message;

    const stripped = content.filter((block) => {
        if (!block || typeof block !== 'object') return true;
        if (params.stripAssistantText && (block as any).type === 'text') return false;
        if (params.stripThinkingText && (block as any).type === 'thinking') return false;
        return true;
    });

    if (stripped.length === content.length) return params.message;
    return {
        ...(params.message as any),
        message: {
            ...((params.message as any).message ?? {}),
            content: stripped,
        },
    } as SDKMessage;
}

export function createClaudeAgentSdkTurnOutputRuntime(params: {
    streamedTranscriptWriter: StreamedTranscriptWriter | null;
    emitMessage: (message: SDKMessage, hints?: { defaultUuid?: string | null }) => void;
    emitAssistantTextMessage: (params: EmitAssistantTextMessageParams) => void;
    flushStreamedTranscriptWriter: (
        reason: 'tool-call-boundary' | 'turn-end' | 'abort',
        interruptedReason?: string,
    ) => Promise<StreamedTranscriptFlushSummary | null>;
    onTurnStartFromStreamEvent?: () => void;
}) {
    const streamedTranscriptWriter = params.streamedTranscriptWriter;
    const streamingToolUses = new Map<
        string,
        { sessionId: string; parentToolUseId: string | null; id: string; name: string; inputJson: string; initialInput: unknown }
    >();
    const streamingToolResults = new Map<
        string,
        { sessionId: string; parentToolUseId: string | null; toolUseId: string; content: string; isError: boolean }
    >();
    const pendingToolUseMessages = new Map<string, { toolUseId: string; message: SDKMessage }>();
    const pendingToolResultMessages = new Map<string, { toolUseId: string; message: SDKMessage }>();
    const bufferedStreamEventAssistantMessages = new Map<
        string,
        { sessionId: string; parentToolUseId: string | null; text: string; thinking: string; lastUuid: string | null }
    >();
    const seen = { toolUseIds: new Set<string>(), toolResultIds: new Set<string>() };
    let didPublishAssistantTextThisTurn = false;
    // Per-sidechain record of which scopes published assistant text this turn, so the result
    // fallback can skip re-emission for any scope that already reached the wire via any channel
    // (streamed deltas, full-message emit, stream-event buffer flush). Root is keyed as null.
    const sidechainsWithPublishedAssistantTextThisTurn = new Set<string | null>();
    const turnDiagnostics: ClaudeAgentSdkTurnDiagnostics = {
        streamedTextDeltaChars: 0,
        streamedThinkingDeltaChars: 0,
        streamedToolUseDeltaChars: 0,
        didPublishAssistantTextThisTurn: false,
        didDurablyFlushAssistantTextThisTurn: false,
    };

    const markAssistantTextPublished = (text: string | null | undefined, sidechainId: string | null) => {
        if (typeof text !== 'string' || text.trim().length === 0) return;
        didPublishAssistantTextThisTurn = true;
        turnDiagnostics.didPublishAssistantTextThisTurn = true;
        sidechainsWithPublishedAssistantTextThisTurn.add(sidechainId);
    };

    const resolveAssistantSegmentFlushSummary = (
        summary: StreamedTranscriptFlushSummary | null,
        sidechainId: string | null,
    ): AssistantSegmentFlushSummary => {
        if (!summary) return null;
        const segmentSummaries = Array.isArray(summary.segments) ? summary.segments : [];
        const exact = segmentSummaries.find(
            (segment) => segment.kind === 'assistant' && segment.sidechainId === sidechainId,
        );
        if (exact) {
            return {
                sawText: exact.sawText,
                didDurablyFlush: exact.didDurablyFlush,
            };
        }
        if (sidechainId !== null) return null;
        return summary.assistantRoot;
    };

    const buildBufferedStreamEventAssistantMessageKey = (message: unknown) => {
        const sessionId = typeof (message as any)?.session_id === 'string' ? (message as any).session_id : '';
        const parentToolUseId = normalizeSidechainIdForStream(message);
        return {
            key: `${sessionId}::${parentToolUseId ?? ''}`,
            sessionId,
            parentToolUseId,
        };
    };

    const ensureBufferedStreamEventAssistantMessage = (message: unknown) => {
        const { key, sessionId, parentToolUseId } = buildBufferedStreamEventAssistantMessageKey(message);
        const uuid = typeof (message as any)?.uuid === 'string' ? (message as any).uuid : null;
        const existing = bufferedStreamEventAssistantMessages.get(key);
        if (!existing) {
            const created = {
                sessionId,
                parentToolUseId,
                text: '',
                thinking: '',
                lastUuid: uuid,
            };
            bufferedStreamEventAssistantMessages.set(key, created);
            return created;
        }
        existing.lastUuid = uuid;
        return existing;
    };

    const flushBufferedAssistantMessages = (incoming: unknown) => {
        const flushOne = (pending: {
            sessionId: string;
            parentToolUseId: string | null;
            text: string;
            thinking: string;
            lastUuid: string | null;
        }) => {
            const pendingAssistantText = pending.text.trim();
            const pendingThinkingText = pending.thinking.trim();
            if (pendingAssistantText.length === 0 && pendingThinkingText.length === 0) return;

            if (streamedTranscriptWriter) {
                markAssistantTextPublished(pendingAssistantText, pending.parentToolUseId);
                return;
            }

            const incomingAssistant = extractAssistantAndThinkingTextFromAssistantMessage(incoming);
            const incomingAssistantText = incomingAssistant.assistantText?.trim() ?? '';
            const incomingThinkingText = incomingAssistant.thinkingText?.trim() ?? '';

            if (
                incoming &&
                typeof incoming === 'object' &&
                (incoming as any).type === 'assistant' &&
                incomingAssistantText === pendingAssistantText &&
                incomingThinkingText === pendingThinkingText
            ) {
                markAssistantTextPublished(pendingAssistantText, pending.parentToolUseId);
                return;
            }

            const defaultUuid =
                typeof pending.lastUuid === 'string' && pending.lastUuid.trim().length > 0
                    ? pending.lastUuid.trim()
                    : null;
            params.emitMessage(
                {
                    type: 'assistant',
                    session_id: pending.sessionId,
                    parent_tool_use_id: pending.parentToolUseId,
                    ...(defaultUuid ? { uuid: defaultUuid } : null),
                    message: {
                        role: 'assistant',
                        content: [
                            ...(pendingThinkingText.length > 0 ? [{ type: 'thinking' as const, thinking: pending.thinking }] : []),
                            ...(pendingAssistantText.length > 0 ? [{ type: 'text' as const, text: pending.text }] : []),
                        ],
                    },
                } as any,
                { defaultUuid },
            );
            markAssistantTextPublished(pendingAssistantText, pending.parentToolUseId);
        };

        if (!incoming) {
            const pendingEntries = Array.from(bufferedStreamEventAssistantMessages.values());
            bufferedStreamEventAssistantMessages.clear();
            for (const pending of pendingEntries) {
                flushOne(pending);
            }
            return;
        }

        const { key } = buildBufferedStreamEventAssistantMessageKey(incoming);
        const pending = bufferedStreamEventAssistantMessages.get(key);
        if (!pending) return;
        bufferedStreamEventAssistantMessages.delete(key);
        flushOne(pending);
    };

    const buildStreamEventToolBlockKey = (message: unknown) => {
        const sessionId = typeof (message as any)?.session_id === 'string' ? (message as any).session_id : '';
        const parentToolUseId = normalizeSidechainIdForStream(message);
        return {
            key: `${sessionId}::${parentToolUseId ?? ''}`,
            sessionId,
            parentToolUseId,
        };
    };

    const reconcilePendingToolMessagesAgainstIncoming = (message: SDKMessage) => {
        const incomingMessageType = (message as any)?.type;
        if (incomingMessageType === 'assistant' || incomingMessageType === 'user' || incomingMessageType === 'result') {
            flushBufferedAssistantMessages(message);
        }

        if (incomingMessageType === 'assistant' || incomingMessageType === 'user' || incomingMessageType === 'result') {
            for (const [key, pendingToolUseMessage] of Array.from(pendingToolUseMessages.entries())) {
                if (messageContainsToolUseId(message, pendingToolUseMessage.toolUseId)) {
                    pendingToolUseMessages.delete(key);
                } else if (incomingMessageType === 'user' && !messageContainsToolResultForToolUseId(message, pendingToolUseMessage.toolUseId)) {
                    continue;
                } else {
                    const deduped = stripSeenToolBlocksFromMessage(pendingToolUseMessage.message, seen);
                    if (deduped) {
                        params.emitMessage(deduped, { defaultUuid: pendingToolUseMessage.toolUseId });
                        recordSeenToolBlocks(deduped, seen);
                    }
                    pendingToolUseMessages.delete(key);
                }
            }
        }

        if (incomingMessageType === 'assistant' || incomingMessageType === 'user' || incomingMessageType === 'result') {
            for (const [key, pendingToolResultMessage] of Array.from(pendingToolResultMessages.entries())) {
                if (messageContainsToolResultForToolUseId(message, pendingToolResultMessage.toolUseId)) {
                    pendingToolResultMessages.delete(key);
                } else {
                    const deduped = stripSeenToolBlocksFromMessage(pendingToolResultMessage.message, seen);
                    if (deduped) {
                        params.emitMessage(deduped, { defaultUuid: pendingToolResultMessage.toolUseId });
                        recordSeenToolBlocks(deduped, seen);
                    }
                    pendingToolResultMessages.delete(key);
                }
            }
        }
    };

    return {
        bufferResultAssistantTextIfNeeded(message: unknown, resultText: string | null) {
            if (!streamedTranscriptWriter && !didPublishAssistantTextThisTurn && resultText) {
                const { key, sessionId, parentToolUseId } = buildBufferedStreamEventAssistantMessageKey(message);
                bufferedStreamEventAssistantMessages.set(key, {
                    sessionId,
                    parentToolUseId,
                    text: resultText,
                    thinking: '',
                    lastUuid: typeof (message as any)?.uuid === 'string' ? (message as any).uuid : null,
                });
                flushBufferedAssistantMessages(message);
            }
        },

        flushBufferedAssistantMessages,

        getDidPublishAssistantTextThisTurn() {
            return didPublishAssistantTextThisTurn;
        },

        getTurnDiagnostics() {
            return { ...turnDiagnostics };
        },

        async handleStreamEvent(message: unknown): Promise<boolean> {
            if (!message || typeof message !== 'object' || (message as any).type !== 'stream_event') {
                return false;
            }

            const signalTurnStart = () => params.onTurnStartFromStreamEvent?.();

            const toolUseStart = extractToolUseStartFromStreamEvent(message);
            if (toolUseStart) {
                signalTurnStart();
                await params.flushStreamedTranscriptWriter('tool-call-boundary');
                flushBufferedAssistantMessages(message);
                const { key, sessionId, parentToolUseId } = buildStreamEventToolBlockKey(message);
                streamingToolUses.set(key, {
                    sessionId,
                    parentToolUseId,
                    id: toolUseStart.id,
                    name: toolUseStart.name,
                    inputJson: '',
                    initialInput: toolUseStart.input,
                });
                return true;
            }

            const toolResultStart = extractToolResultStartFromStreamEvent(message);
            if (toolResultStart) {
                signalTurnStart();
                flushBufferedAssistantMessages(message);
                const { key, sessionId, parentToolUseId } = buildStreamEventToolBlockKey(message);
                streamingToolResults.set(key, {
                    sessionId,
                    parentToolUseId,
                    toolUseId: toolResultStart.toolUseId,
                    content: toolResultStart.content ?? '',
                    isError: toolResultStart.isError ?? false,
                });
                return true;
            }

            const thinkingStart = extractThinkingStartFromStreamEvent(message);
            if (thinkingStart) {
                signalTurnStart();
                const buffered = ensureBufferedStreamEventAssistantMessage(message);
                buffered.thinking += thinkingStart;
                turnDiagnostics.streamedThinkingDeltaChars += thinkingStart.length;
                streamedTranscriptWriter?.appendThinkingDelta(thinkingStart, { sidechainId: normalizeSidechainIdForStream(message) });
                return true;
            }

            const textStart = extractTextStartFromStreamEvent(message);
            if (textStart) {
                signalTurnStart();
                const { key } = buildStreamEventToolBlockKey(message);
                const streamingToolResult = streamingToolResults.get(key) ?? null;
                if (!streamingToolResult) {
                    const buffered = ensureBufferedStreamEventAssistantMessage(message);
                    buffered.text += textStart;
                    turnDiagnostics.streamedTextDeltaChars += textStart.length;
                    streamedTranscriptWriter?.appendAssistantDelta(textStart, { sidechainId: normalizeSidechainIdForStream(message) });
                } else {
                    streamingToolResult.content += textStart;
                    turnDiagnostics.streamedToolUseDeltaChars += textStart.length;
                }
                return true;
            }

            const toolUseInputDelta = extractToolUseInputJsonDeltaFromStreamEvent(message);
            if (toolUseInputDelta) {
                signalTurnStart();
                const { key } = buildStreamEventToolBlockKey(message);
                const streamingToolUse = streamingToolUses.get(key);
                if (streamingToolUse) {
                    streamingToolUse.inputJson += toolUseInputDelta;
                    turnDiagnostics.streamedToolUseDeltaChars += toolUseInputDelta.length;
                }
                return true;
            }

            const thinkingDelta = extractThinkingDeltaFromStreamEvent(message);
            if (thinkingDelta) {
                signalTurnStart();
                const buffered = ensureBufferedStreamEventAssistantMessage(message);
                buffered.thinking += thinkingDelta;
                turnDiagnostics.streamedThinkingDeltaChars += thinkingDelta.length;
                streamedTranscriptWriter?.appendThinkingDelta(thinkingDelta, { sidechainId: normalizeSidechainIdForStream(message) });
                return true;
            }

            const textDelta = extractTextDeltaFromStreamEvent(message);
            if (textDelta) {
                signalTurnStart();
                const { key } = buildStreamEventToolBlockKey(message);
                const streamingToolResult = streamingToolResults.get(key) ?? null;
                if (!streamingToolResult) {
                    const buffered = ensureBufferedStreamEventAssistantMessage(message);
                    buffered.text += textDelta;
                    turnDiagnostics.streamedTextDeltaChars += textDelta.length;
                    streamedTranscriptWriter?.appendAssistantDelta(textDelta, { sidechainId: normalizeSidechainIdForStream(message) });
                } else {
                    streamingToolResult.content += textDelta;
                    turnDiagnostics.streamedToolUseDeltaChars += textDelta.length;
                }
                return true;
            }

            if (isContentBlockStopStreamEvent(message)) {
                const { key } = buildStreamEventToolBlockKey(message);
                const streamingToolUse = streamingToolUses.get(key) ?? null;
                if (streamingToolUse) {
                    if (seen.toolUseIds.has(streamingToolUse.id)) {
                        streamingToolUses.delete(key);
                        return true;
                    }

                    const inputFromJson = (() => {
                        const raw = streamingToolUse.inputJson.trim();
                        if (!raw) return null;
                        try {
                            return JSON.parse(raw) as unknown;
                        } catch {
                            return null;
                        }
                    })();

                    pendingToolUseMessages.set(key, {
                        toolUseId: streamingToolUse.id,
                        message: {
                            type: 'assistant',
                            session_id: streamingToolUse.sessionId,
                            parent_tool_use_id: streamingToolUse.parentToolUseId,
                            uuid: streamingToolUse.id,
                            message: {
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: streamingToolUse.id,
                                        name: streamingToolUse.name,
                                        input: inputFromJson ?? streamingToolUse.initialInput ?? {},
                                    },
                                ],
                            },
                        } as any,
                    });

                    streamingToolUses.delete(key);
                    return true;
                }

                const streamingToolResult = streamingToolResults.get(key) ?? null;
                if (streamingToolResult) {
                    if (seen.toolResultIds.has(streamingToolResult.toolUseId)) {
                        streamingToolResults.delete(key);
                        return true;
                    }

                    pendingToolResultMessages.set(key, {
                        toolUseId: streamingToolResult.toolUseId,
                        message: {
                            type: 'user',
                            session_id: streamingToolResult.sessionId,
                            parent_tool_use_id: streamingToolResult.parentToolUseId,
                            uuid: streamingToolResult.toolUseId,
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: streamingToolResult.toolUseId,
                                        content: streamingToolResult.content,
                                        is_error: Boolean(streamingToolResult.isError),
                                    },
                                ],
                            },
                        } as any,
                    });
                    streamingToolResults.delete(key);
                    return true;
                }
            }

            if (isMessageStopStreamEvent(message)) {
                flushBufferedAssistantMessages(message);
                return true;
            }

            return true;
        },

        maybeEmitResultAssistantFallback(
            message: unknown,
            resultText: string | null,
            lastTurnFlushSummary: StreamedTranscriptFlushSummary | null,
        ): boolean {
            if (!streamedTranscriptWriter || typeof resultText !== 'string' || resultText.trim().length === 0) {
                return false;
            }
            const sidechainId = normalizeSidechainIdForStream(message);
            // Belt-and-suspenders: if assistant text already reached the wire for THIS scope
            // (root or sidechain) via any channel this turn (streamed deltas, full-message emit,
            // buffered stream-event flush), re-emitting from the result message would duplicate
            // the message AND write a synthetic uuid that could later become an unsafe resume
            // anchor. Durable flushing is the preferred signal; this guard catches any
            // other delivery path.
            if (sidechainsWithPublishedAssistantTextThisTurn.has(sidechainId)) {
                return false;
            }
            const assistantFlush = resolveAssistantSegmentFlushSummary(lastTurnFlushSummary, sidechainId);
            if (sidechainId === null) {
                if (assistantFlush?.didDurablyFlush === true) {
                    return false;
                }
            } else if (assistantFlush?.sawText !== true || assistantFlush.didDurablyFlush === true) {
                return false;
            }
            const sessionId = typeof (message as any)?.session_id === 'string' ? (message as any).session_id : '';
            const uuid = typeof (message as any)?.uuid === 'string' ? (message as any).uuid : null;
            params.emitAssistantTextMessage({
                sessionId,
                parentToolUseId: sidechainId,
                assistantText: resultText,
                defaultUuid: uuid,
            });
            logger.debug('[claudeRemoteAgentSdk] Materialized result assistant fallback after non-durable streamed flush', {
                sidechainId,
                resultTextLength: resultText.length,
            });
            return true;
        },

        noteDurableAssistantFlush(summary: StreamedTranscriptFlushSummary | null) {
            turnDiagnostics.didDurablyFlushAssistantTextThisTurn = summary?.assistantRoot.didDurablyFlush === true;
        },

        prepareIncomingMessage(message: SDKMessage): SDKMessage | null {
            reconcilePendingToolMessagesAgainstIncoming(message);

            const deduped = stripSeenToolBlocksFromMessage(message, seen);
            if (!deduped) return null;

            let messageToEmit = deduped;
            if (message.type === 'assistant' && streamedTranscriptWriter) {
                const { assistantText, thinkingText } = extractAssistantAndThinkingTextFromAssistantMessage(deduped);
                const sidechainId = normalizeSidechainIdForStream(deduped);
                let stripThinkingText = false;
                let stripAssistantText = false;
                if (typeof thinkingText === 'string' && thinkingText.length > 0) {
                    stripThinkingText = streamedTranscriptWriter.overrideThinkingText(thinkingText, { sidechainId });
                }
                if (typeof assistantText === 'string' && assistantText.length > 0) {
                    stripAssistantText = streamedTranscriptWriter.overrideAssistantText(assistantText, { sidechainId });
                }
                messageToEmit = stripCoveredAssistantBlocks({
                    message: deduped,
                    stripAssistantText,
                    stripThinkingText,
                });
                markAssistantTextPublished(assistantText, sidechainId);
            } else if (message.type === 'assistant') {
                markAssistantTextPublished(
                    extractAssistantAndThinkingTextFromAssistantMessage(deduped).assistantText,
                    normalizeSidechainIdForStream(deduped),
                );
            }

            recordSeenToolBlocks(messageToEmit, seen);
            return messageToEmit;
        },

        resetTurnOutputState() {
            didPublishAssistantTextThisTurn = false;
            sidechainsWithPublishedAssistantTextThisTurn.clear();
            turnDiagnostics.streamedTextDeltaChars = 0;
            turnDiagnostics.streamedThinkingDeltaChars = 0;
            turnDiagnostics.streamedToolUseDeltaChars = 0;
            turnDiagnostics.didPublishAssistantTextThisTurn = false;
            turnDiagnostics.didDurablyFlushAssistantTextThisTurn = false;
        },
    };
}
