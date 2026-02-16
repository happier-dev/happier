import type { TracedMessage } from '../reducerTracer';
import type { UsageData } from '../../typesRaw';
import type { ReducerState } from '../reducer';
import type { ToolCall } from '../../domains/messages/messageTypes';
import { normalizeThinkingChunk, unwrapThinkingText, wrapThinkingText } from '../helpers/thinkingText';
import { cancelRunningTools } from '../helpers/cancelRunningApprovedTools';
import { drainAndApplyOrphanToolResultsToMessage } from '../helpers/drainAndApplyOrphanToolResultsToMessage';

export function runUserAndTextPhase(params: Readonly<{
    state: ReducerState;
    nonSidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
    processUsageData: (state: ReducerState, usage: UsageData, timestamp: number) => void;
    lastMainThinkingMessageId: string | null;
    lastMainThinkingCreatedAt: number | null;
    isPermissionRequestToolCall: (toolId: string, input: unknown) => boolean;
}>): Readonly<{
    lastMainThinkingMessageId: string | null;
    lastMainThinkingCreatedAt: number | null;
}> {
    const {
        state,
        nonSidechainMessages,
        changed,
        allocateId,
        processUsageData,
    } = params;
    const isPermissionRequestToolCall = params.isPermissionRequestToolCall;

    let lastMainThinkingMessageId = params.lastMainThinkingMessageId;
    let lastMainThinkingCreatedAt = params.lastMainThinkingCreatedAt;
    let lastMainStreamMessageId: string | null = null;
    let lastMainStreamKey: string | null = null;

    //
    // Phase 1: Process non-sidechain user messages and text messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'user') {
            // Check if we've seen this localId before
            if (msg.localId && state.localIds.has(msg.localId)) {
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Create a new message
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                seq: typeof msg.seq === 'number' ? msg.seq : null,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tool: null,
                event: null,
                meta: msg.meta,
            });

            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);

            changed.add(mid);
            lastMainThinkingMessageId = null;
            lastMainThinkingCreatedAt = null;
            lastMainStreamMessageId = null;
            lastMainStreamKey = null;
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);

            // Process usage data if present
            if (msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt);
            }

            // Process text and thinking content (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text') {
                    const streamKey =
                        msg.meta && typeof (msg.meta as any).happierStreamKey === 'string'
                            ? String((msg.meta as any).happierStreamKey)
                            : null;

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
                            changed.add(lastMainStreamMessageId!);
                        }
                        lastMainThinkingMessageId = null;
                        lastMainThinkingCreatedAt = null;
                        continue;
                    }

                    if (c.text.trim() === 'No response requested.') {
                        cancelRunningTools({
                            state,
                            changed,
                            completedAt: msg.createdAt,
                            reason: 'Request interrupted',
                        });
                    }
                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        seq: typeof msg.seq === 'number' ? msg.seq : null,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: c.text,
                        isThinking: false,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    });
                    changed.add(mid);
                    lastMainThinkingMessageId = null;
                    lastMainThinkingCreatedAt = null;
                    lastMainStreamMessageId = mid;
                    lastMainStreamKey = streamKey;
                } else if (c.type === 'thinking') {
                    const chunk = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
                    if (!chunk.trim()) {
                        continue;
                    }
                    lastMainStreamMessageId = null;
                    lastMainStreamKey = null;

                    const prevThinkingId = lastMainThinkingMessageId;
                    const canAppendToPrevious =
                        prevThinkingId
                        && lastMainThinkingCreatedAt !== null
                        && msg.createdAt - lastMainThinkingCreatedAt < 120_000
                        && (() => {
                            const prev = state.messages.get(prevThinkingId);
                            return prev?.role === 'agent' && prev.isThinking && typeof prev.text === 'string';
                        })();

                    if (canAppendToPrevious) {
                        const prev = prevThinkingId ? state.messages.get(prevThinkingId) : null;
                        if (prev && typeof prev.text === 'string') {
                            const merged = unwrapThinkingText(prev.text) + chunk;
                            prev.text = wrapThinkingText(merged);
                            changed.add(prevThinkingId!);
                        }
                    } else {
                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            seq: typeof msg.seq === 'number' ? msg.seq : null,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: wrapThinkingText(chunk),
                            isThinking: true,
                            tool: null,
                            event: null,
                            meta: msg.meta,
                        });
                        changed.add(mid);
                        lastMainThinkingMessageId = mid;
                        lastMainThinkingCreatedAt = msg.createdAt;
                    }
                } else if (c.type === 'tool-call') {
                    // Tool calls are handled in Phase 2 for permission matching and late-arriving updates,
                    // but we still materialize the tool-call message here to preserve the intra-message
                    // timeline ordering (thinking → tool → thinking).
                    lastMainThinkingMessageId = null;
                    lastMainThinkingCreatedAt = null;
                    lastMainStreamMessageId = null;
                    lastMainStreamKey = null;

                    const existingMessageId = state.toolIdToMessageId.get(c.id);
                    if (existingMessageId) {
                        continue;
                    }

                    const permission = state.permissions.get(c.id);
                    const toolInput = permission ? permission.arguments : c.input;
                    const toolCreatedAt = permission ? permission.createdAt : msg.createdAt;
                    const pendingPermission = !permission && isPermissionRequestToolCall(c.id, toolInput);

                    let toolCall: ToolCall = {
                        id: c.id,
                        name: c.name,
                        state: 'running' as const,
                        input: toolInput,
                        createdAt: toolCreatedAt,
                        startedAt: pendingPermission ? null : msg.createdAt,
                        completedAt: null,
                        description: c.description,
                        result: undefined,
                    };

                    if (permission) {
                        toolCall.permission = {
                            id: c.id,
                            status: permission.status,
                            reason: permission.reason,
                            mode: permission.mode,
                            allowedTools: permission.allowedTools ?? permission.allowTools,
                            decision: permission.decision,
                        };

                        if (permission.status !== 'approved') {
                            toolCall.state = 'error';
                            toolCall.completedAt = permission.completedAt || msg.createdAt;
                            if (permission.reason) {
                                toolCall.result = { error: permission.reason };
                            }
                        }
                    } else if (pendingPermission) {
                        toolCall.permission = { id: c.id, status: 'pending' };
                        state.permissions.set(c.id, {
                            tool: c.name,
                            arguments: toolInput,
                            createdAt: msg.createdAt,
                            status: 'pending',
                        });
                    }

                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        seq: typeof msg.seq === 'number' ? msg.seq : null,
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
    }

    return { lastMainThinkingMessageId, lastMainThinkingCreatedAt };
}
