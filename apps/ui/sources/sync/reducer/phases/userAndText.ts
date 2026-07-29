import type { TracedMessage } from '../reducerTracer';
import type { UsageData } from '../../typesRaw';
import type { ReducerState } from '../reducer';
import { clearAllMainMergeCursors, setStreamMergeCursor, setThinkingMergeCursor } from '../helpers/mergeCursors';
import { mergeThinkingText, normalizeThinkingChunk } from '../helpers/thinkingText';
import { drainAndApplyOrphanToolResultsToMessage } from '../helpers/drainAndApplyOrphanToolResultsToMessage';
import { readStreamSegmentMetaV1 } from '../helpers/streamSegmentMeta';
import { upsertStreamSegmentSnapshotMessage } from '../helpers/upsertStreamSegmentSnapshotMessage';
import { hasSyntheticNoResponseMeta } from '../../domains/messages/syntheticNoResponseMessageMeta';
import { normalizeTranscriptSeq, transcriptBlockIndexFromContentIndex } from '../../domains/messages/transcriptOrdering';
import { createTranscriptToolCallProjection } from '../helpers/toolCallProjection';
import { isRecoveredHistoryTranscriptObservation } from '../../domains/messages/transcriptObservationProvenance';

export function runUserAndTextPhase(params: Readonly<{
    state: ReducerState;
    nonSidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
    processUsageData: (state: ReducerState, usage: UsageData, timestamp: number) => void;
    lastMainThinkingMessageId: string | null;
    lastMainStreamMessageId: string | null;
    lastMainStreamKey: string | null;
    isPermissionRequestToolCall: (toolId: string, input: unknown) => boolean;
}>): void {
    const {
        state,
        nonSidechainMessages,
        changed,
        allocateId,
        processUsageData,
    } = params;
    const isPermissionRequestToolCall = params.isPermissionRequestToolCall;

    let lastMainThinkingMessageId = params.lastMainThinkingMessageId;
    let lastMainStreamMessageId: string | null = params.lastMainStreamMessageId;
    let lastMainStreamKey: string | null = params.lastMainStreamKey;
    let isolateRecoveredHistory = false;

    const setThinkingCursor = (next: string | null, reason: string) => {
        if (!isolateRecoveredHistory) setThinkingMergeCursor(state, next, reason);
        lastMainThinkingMessageId = next;
    };

    const setStreamCursor = (next: { messageId: string; streamKey: string } | null, reason: string) => {
        if (!isolateRecoveredHistory) setStreamMergeCursor(state, next, reason);
        lastMainStreamMessageId = next?.messageId ?? null;
        lastMainStreamKey = next?.streamKey ?? null;
    };

    const clearAllCursors = (reason: string) => {
        if (!isolateRecoveredHistory) clearAllMainMergeCursors(state, reason);
        lastMainThinkingMessageId = null;
        lastMainStreamMessageId = null;
        lastMainStreamKey = null;
    };

    //
    // Phase 1: Process non-sidechain user messages and text messages
    //

    for (let msg of nonSidechainMessages) {
        const isRecoveredHistory = isRecoveredHistoryTranscriptObservation(msg);
        const retainedThinkingMessageId = lastMainThinkingMessageId;
        const retainedStreamMessageId = lastMainStreamMessageId;
        const retainedStreamKey = lastMainStreamKey;
        isolateRecoveredHistory = isRecoveredHistory;
        if (isRecoveredHistory) {
            lastMainThinkingMessageId = null;
            lastMainStreamMessageId = null;
            lastMainStreamKey = null;
        }
        const restoreLiveMergeCursors = () => {
            if (!isRecoveredHistory) return;
            lastMainThinkingMessageId = retainedThinkingMessageId;
            lastMainStreamMessageId = retainedStreamMessageId;
            lastMainStreamKey = retainedStreamKey;
            isolateRecoveredHistory = false;
        };
        if (msg.role === 'user') {
            // Check if we've seen this localId before
            if (!isRecoveredHistory && msg.localId && state.localIds.has(msg.localId)) {
                restoreLiveMergeCursors();
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                restoreLiveMergeCursors();
                continue;
            }

            // Create a new message
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                seq: normalizeTranscriptSeq(msg.seq),
                localId: msg.localId ?? null,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tool: null,
                event: null,
                meta: msg.meta,
            });

            // Track both localId and messageId
            if (msg.localId && !isRecoveredHistory) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);

            changed.add(mid);
            clearAllCursors('user-message');
        } else if (msg.role === 'agent') {
            // Process usage data if present
            if (msg.usage && !isRecoveredHistory) {
                processUsageData(state, msg.usage, msg.createdAt);
            }

	            // Process text and thinking content (tool calls handled in Phase 2)
                let thinkingRunIndex = 0;
                let isThinkingRunOpen = false;
	            for (let contentIndex = 0; contentIndex < msg.content.length; contentIndex += 1) {
                    const c = msg.content[contentIndex]!;
                    const transcriptBlockIndex = transcriptBlockIndexFromContentIndex(contentIndex);
                    if (c.type !== 'thinking' && isThinkingRunOpen) {
                        thinkingRunIndex += 1;
                        isThinkingRunOpen = false;
                    }

	                if (c.type === 'text') {
                    const text = String(c.text ?? '');
                    if (hasSyntheticNoResponseMeta(msg.meta)) {
                        clearAllCursors('synthetic-no-response');
                        continue;
                    }
	                    const streamSegmentMeta = readStreamSegmentMetaV1(msg.meta);
	                    const streamSegmentKind = streamSegmentMeta?.segmentKind ?? null;
	                    const streamSegmentLocalId = streamSegmentMeta?.segmentLocalId ?? msg.localId;
	                    if (streamSegmentKind === 'assistant' && streamSegmentLocalId) {
                        const nextText = text;
                        const hasVisibleText = nextText.trim().length > 0;
                        const upsert = upsertStreamSegmentSnapshotMessage({
                            state,
                            allocateId,
                            localId: streamSegmentLocalId,
                            realID: msg.id,
                            createdAt: msg.createdAt,
                            seq: msg.seq,
                            transcriptBlockIndex,
                            isThinking: false,
                            text: nextText,
                            meta: msg.meta,
                            markChanged: (messageId) => changed.add(messageId),
                        });

                        if (upsert.accepted && hasVisibleText) {
                            setThinkingCursor(null, 'agent-text-stream-segment');
                        }
                        continue;
	                    }

                    const streamKeyFromMeta =
                        msg.meta && typeof (msg.meta as any).happierStreamKey === 'string'
                            ? String((msg.meta as any).happierStreamKey)
                            : null;

                    // Provider-agnostic fallback: some transports reuse the same agent message id for
                    // incremental chunks but do not attach a stable stream key. Use the transport id
                    // as a merge key so streaming remains coherent until the server snapshot reload.
                      const shouldUseIdFallback = !streamKeyFromMeta && msg.content.length === 1 && Boolean(msg.id);
                      const streamKey = streamKeyFromMeta ?? (shouldUseIdFallback ? `id:${msg.id}` : null);

                      const textDelta = String(c.text ?? '');
                        const hasVisibleText = textDelta.trim().length > 0;

                      const canMerge =
                          streamKey
                          && lastMainStreamMessageId
                          && lastMainStreamKey === streamKey
                          && (() => {
                            const prev = state.messages.get(lastMainStreamMessageId!);
                            return prev?.role === 'agent' && !prev.isThinking && typeof prev.text === 'string';
                        })();

                    if (canMerge) {
                        const prev = state.messages.get(lastMainStreamMessageId!);
                        if (prev && typeof prev.text === 'string') {
                            prev.text = prev.text + String(c.text ?? '');
                            const nextSeq = normalizeTranscriptSeq(msg.seq);
                            if (nextSeq !== null && (prev.seq === null || nextSeq > prev.seq)) {
                                prev.seq = nextSeq;
                            }
                            changed.add(lastMainStreamMessageId!);
                        }
                        // Keep the cursor stable even if thinking/tool deltas arrive between text chunks.
                        setStreamCursor({ messageId: lastMainStreamMessageId!, streamKey }, 'agent-text-merge');
                        if (hasVisibleText) {
                            setThinkingCursor(null, 'agent-text-merge');
                        }
                        continue;
                    }

                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        seq: normalizeTranscriptSeq(msg.seq),
                        transcriptBlockIndex,
                        localId: msg.localId ?? null,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        isThinking: false,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    });
                    changed.add(mid);
                    if (hasVisibleText) {
                        setThinkingCursor(null, 'agent-text-create');
                    }
                    setStreamCursor(streamKey ? { messageId: mid, streamKey } : null, 'agent-text-create');
	                } else if (c.type === 'thinking') {
	                    const streamSegmentMeta = readStreamSegmentMetaV1(msg.meta);
	                    const streamSegmentKind = streamSegmentMeta?.segmentKind ?? null;
	                    const streamSegmentLocalId = streamSegmentMeta?.segmentLocalId ?? msg.localId;
	                    if (streamSegmentKind === 'thinking' && streamSegmentLocalId) {
	                        const nextText = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
	                        const hasVisibleText = nextText.trim().length > 0;
                        const upsert = upsertStreamSegmentSnapshotMessage({
                            state,
                            allocateId,
                            localId: streamSegmentLocalId,
                            realID: msg.id,
                            createdAt: msg.createdAt,
                            seq: msg.seq,
                            transcriptBlockIndex,
                            isThinking: true,
                            text: nextText,
                            meta: msg.meta,
                            markChanged: (messageId) => changed.add(messageId),
                        });

                        if (upsert.didCreate && upsert.messageId) {
                            setThinkingCursor(upsert.messageId, 'agent-thinking-stream-segment');
                        }

                        if (upsert.accepted && hasVisibleText) {
                            setStreamCursor(null, 'agent-thinking-stream-segment');
                        }
                        continue;
	                    }

                    const chunk = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
                    const hasVisibleText = chunk.trim().length > 0;
                    const hasParagraphBreak = chunk.includes('\n\n');
                    if (!hasVisibleText && !hasParagraphBreak) {
                        continue;
                    }

                    isThinkingRunOpen = true;

                    const thinkingUuid =
                        typeof (c as any).uuid === 'string' && (c as any).uuid.trim().length > 0
                            ? (c as any).uuid.trim()
                            : null;
                    const thinkingSegmentKey = thinkingUuid ? `${thinkingUuid}#${thinkingRunIndex}` : null;

                    if (thinkingSegmentKey) {
                        const mappedId = state.thinkingSegmentKeyToMessageId.get(thinkingSegmentKey);
                        if (mappedId) {
                            const mapped = state.messages.get(mappedId) ?? null;
                            if (mapped && mapped.role === 'agent' && mapped.isThinking && typeof mapped.text === 'string') {
                                mapped.text = mergeThinkingText(mapped.text, chunk);
                                const nextSeq = normalizeTranscriptSeq(msg.seq);
                                if (nextSeq !== null && (mapped.seq === null || nextSeq > mapped.seq)) {
                                    mapped.seq = nextSeq;
                                }
                                changed.add(mappedId);
                                setThinkingCursor(mappedId, 'agent-thinking-uuid-merge');
                                continue;
                            }

                            state.thinkingSegmentKeyToMessageId.delete(thinkingSegmentKey);
                        }
                    }

                    const prevThinkingId = lastMainThinkingMessageId;
                    const canAppendToPrevious =
                        prevThinkingId
                        && (() => {
                            const prev = state.messages.get(prevThinkingId);
                            return prev?.role === 'agent' && prev.isThinking && typeof prev.text === 'string';
                        })();

                      if (canAppendToPrevious) {
                          const prev = prevThinkingId ? state.messages.get(prevThinkingId) : null;
                          if (prev && typeof prev.text === 'string') {
                              prev.text = mergeThinkingText(prev.text, chunk);
                            const nextSeq = normalizeTranscriptSeq(msg.seq);
                            if (nextSeq !== null && (prev.seq === null || nextSeq > prev.seq)) {
                                prev.seq = nextSeq;
                            }
                            changed.add(prevThinkingId!);
                        }
                        setThinkingCursor(prevThinkingId!, 'agent-thinking-append');
                        if (thinkingSegmentKey) {
                            state.thinkingSegmentKeyToMessageId.set(thinkingSegmentKey, prevThinkingId!);
                        }
                    } else {
                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            seq: normalizeTranscriptSeq(msg.seq),
                            transcriptBlockIndex,
                            localId: msg.localId ?? null,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: chunk,
                            isThinking: true,
                            tool: null,
                            event: null,
                            meta: msg.meta,
                        });
                        changed.add(mid);
                        setThinkingCursor(mid, 'agent-thinking-create');
                        if (thinkingSegmentKey) {
                            state.thinkingSegmentKeyToMessageId.set(thinkingSegmentKey, mid);
                        }
                    }
                } else if (c.type === 'tool-call') {
                    // Tool calls are handled in Phase 2 for permission matching and late-arriving updates,
                    // but we still materialize the tool-call message here to preserve the intra-message
                    // timeline ordering (thinking → tool → thinking).
                    clearAllCursors('agent-tool-call');

                    const existingMessageId = state.toolIdToMessageId.get(c.id);
                    if (existingMessageId != null) {
                        continue;
                    }

                    const permission = state.permissions.get(c.id);
                    const projection = createTranscriptToolCallProjection({
                        toolId: c.id,
                        toolName: c.name,
                        toolInput: c.input,
                        description: c.description,
                        messageCreatedAt: msg.createdAt,
                        permission,
                        isPendingPermissionRequest: !permission && isPermissionRequestToolCall(c.id, c.input),
                    });
                    const toolCall = projection.toolCall;

                    if (projection.shouldStorePendingPermission) {
                        state.permissions.set(c.id, {
                            tool: c.name,
                            arguments: c.input,
                            createdAt: msg.createdAt,
                            status: 'pending',
                        });
                    }

                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        seq: normalizeTranscriptSeq(msg.seq),
                        transcriptBlockIndex,
                        localId: msg.localId ?? null,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        isThinking: false,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                    });
                    state.toolIdToMessageId.set(c.id, mid);
                    changed.add(mid);

                    drainAndApplyOrphanToolResultsToMessage({
                        state,
                        toolUseId: c.id,
                        messageId: mid,
                        changed,
                    });
                }
            }
        }
        restoreLiveMergeCursors();
    }
}
