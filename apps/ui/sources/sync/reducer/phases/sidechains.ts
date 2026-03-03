import type { ToolCall } from '../../domains/messages/messageTypes';
import type { TracedMessage } from '../reducerTracer';
import type { ReducerMessage, ReducerState } from '../reducer';
import { getSidechainThinkingMergeCursor, setSidechainThinkingMergeCursor } from '../helpers/mergeCursors';
import { applyToolResultUpdateToReducerMessage } from '../helpers/applyToolResultUpdateToReducerMessage';
import { normalizeThinkingChunk, unwrapThinkingText } from '../helpers/thinkingText';

export function runSidechainsPhase(params: Readonly<{
    state: ReducerState;
    sidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
}>): void {
    const { state, sidechainMessages, changed, allocateId } = params;

    //
    // Phase 4: Process sidechains and store them in state
    //

    // For each sidechain message, store it in the state and mark the Task as changed
    for (const msg of sidechainMessages) {
        if (!msg.sidechainId) continue;
        const sidechainId = msg.sidechainId;

        // Skip if we already processed this message
        if (state.messageIds.has(msg.id)) continue;

        // Mark as processed
        state.messageIds.set(msg.id, msg.id);

        // Get or create the sidechain array for this Task
        const existingSidechain = state.sidechains.get(sidechainId) || [];
        const parentMessageId = state.toolIdToMessageId.get(sidechainId) ?? null;
        const isOrphanSidechain = parentMessageId == null;
        const markChangedIfOrphan = (messageId: string) => {
            if (isOrphanSidechain) changed.add(messageId);
        };

        // Process and add new sidechain messages
        if (msg.role === 'agent' && msg.content[0]?.type === 'sidechain') {
            // This is the sidechain root - create a user message
            const mid = allocateId();
            const userMsg: ReducerMessage = {
                id: mid,
                realID: msg.id,
                seq: typeof msg.seq === 'number' ? msg.seq : null,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content[0].prompt,
                tool: null,
                event: null,
                meta: msg.meta,
            };
            state.messages.set(mid, userMsg);
            existingSidechain.push(userMsg);
            markChangedIfOrphan(mid);
            setSidechainThinkingMergeCursor(state, sidechainId, null, 'sidechain-root');
        } else if (msg.role === 'agent') {
            // Process agent content in sidechain
            for (const c of msg.content) {
                if (c.type === 'text') {
                    const streamKey =
                        msg.meta && typeof (msg.meta as any).happierSidechainStreamKey === 'string'
                            ? String((msg.meta as any).happierSidechainStreamKey)
                            : null;

                    const last = existingSidechain[existingSidechain.length - 1];
                    const textDelta = String(c.text ?? '');
                    const hasVisibleText = textDelta.trim().length > 0;

                    const canMerge =
                        streamKey &&
                        last &&
                        last.role === 'agent' &&
                        !last.isThinking &&
                        typeof last.text === 'string' &&
                        last.meta &&
                        typeof (last.meta as any).happierSidechainStreamKey === 'string' &&
                        String((last.meta as any).happierSidechainStreamKey) === streamKey;

                    if (canMerge) {
                        last.text = String(last.text ?? '') + String(c.text ?? '');
                        markChangedIfOrphan(last.id);
                        // Sidechain children must never be emitted as root-level transcript messages.
                        // Marking the owning Task/SubAgentRun tool-call as changed (below) is sufficient
                        // to refresh the child transcript in both the task view and the main session view.
                    } else {
                        const mid = allocateId();
                        const textMsg: ReducerMessage = {
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
                        };
                        state.messages.set(mid, textMsg);
                        existingSidechain.push(textMsg);
                        markChangedIfOrphan(mid);
                    }

                    if (hasVisibleText) {
                        setSidechainThinkingMergeCursor(state, sidechainId, null, 'sidechain-text');
                    }
                } else if (c.type === 'thinking') {
                    const chunk = typeof c.thinking === 'string' ? normalizeThinkingChunk(c.thinking) : '';
                    const hasVisibleText = chunk.trim().length > 0;
                    const hasParagraphBreak = chunk.includes('\n\n');
                    if (!hasVisibleText && !hasParagraphBreak) {
                        continue;
                    }

                    const cursorId = getSidechainThinkingMergeCursor(state, sidechainId);
                    const cursorMessage = cursorId ? state.messages.get(cursorId) : null;
                    if (
                        cursorMessage &&
                        cursorMessage.role === 'agent' &&
                        cursorMessage.isThinking &&
                        typeof cursorMessage.text === 'string'
                    ) {
                        const merged = unwrapThinkingText(cursorMessage.text) + chunk;
                        cursorMessage.text = merged;
                        markChangedIfOrphan(cursorMessage.id);
                        setSidechainThinkingMergeCursor(state, sidechainId, cursorId, 'sidechain-thinking-append');
                    } else {
                        const last = existingSidechain[existingSidechain.length - 1];
                        if (last && last.role === 'agent' && last.isThinking && typeof last.text === 'string') {
                            const merged = unwrapThinkingText(last.text) + chunk;
                            last.text = merged;
                            markChangedIfOrphan(last.id);
                            setSidechainThinkingMergeCursor(state, sidechainId, last.id, 'sidechain-thinking-append');
                            // Sidechain children must never be emitted as root-level transcript messages.
                            // Marking the owning Task/SubAgentRun tool-call as changed (below) is sufficient
                            // to refresh the child transcript in both the task view and the main session view.
                        } else {
                            const mid = allocateId();
                            const textMsg: ReducerMessage = {
                                id: mid,
                                realID: msg.id,
                                seq: typeof msg.seq === 'number' ? msg.seq : null,
                                role: 'agent',
                                createdAt: msg.createdAt,
                                text: chunk,
                                isThinking: true,
                                tool: null,
                                event: null,
                                meta: msg.meta,
                            };
                            state.messages.set(mid, textMsg);
                            existingSidechain.push(textMsg);
                            markChangedIfOrphan(mid);
                            setSidechainThinkingMergeCursor(state, sidechainId, mid, 'sidechain-thinking-create');
                        }
                    }
                } else if (c.type === 'tool-call') {
                    setSidechainThinkingMergeCursor(state, sidechainId, null, 'sidechain-tool-call');
                    // Check if there's already a permission message for this tool
                    const existingPermissionMessageId = state.toolIdToMessageId.get(c.id);

                    const mid = allocateId();
                    const toolCall: ToolCall = {
                        id: c.id,
                        name: c.name,
                        state: 'running' as const,
                        input: c.input,
                        createdAt: msg.createdAt,
                        startedAt: null,
                        completedAt: null,
                        description: c.description,
                        result: undefined,
                    };

                    // If there's a permission message, copy its permission info
                    if (existingPermissionMessageId) {
                        const permissionMessage = state.messages.get(existingPermissionMessageId);
                        if (permissionMessage?.tool?.permission) {
                            toolCall.permission = { ...permissionMessage.tool.permission };
                            // Update the permission message to show it's running
                            if (permissionMessage.tool.state !== 'completed' && permissionMessage.tool.state !== 'error') {
                                permissionMessage.tool.state = 'running';
                                permissionMessage.tool.startedAt = msg.createdAt;
                                permissionMessage.tool.description = c.description;
                                changed.add(existingPermissionMessageId);
                            }
                        }
                    }

                    const toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        seq: typeof msg.seq === 'number' ? msg.seq : null,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);
                    markChangedIfOrphan(mid);

                    // Map sidechain tool separately to avoid overwriting permission mapping
                    state.sidechainToolIdToMessageId.set(c.id, mid);
                } else if (c.type === 'tool-result') {
                    // Process tool result in sidechain - update BOTH messages
                    const toolResult = {
                        tool_use_id: c.tool_use_id,
                        content: c.content,
                        is_error: c.is_error,
                        ...(c.permissions ? { permissions: c.permissions } : {}),
                    };

                    // Update the sidechain tool message
                    const sidechainMessageId = state.sidechainToolIdToMessageId.get(c.tool_use_id);
                    if (sidechainMessageId) {
                        const sidechainMessage = state.messages.get(sidechainMessageId);
                        if (sidechainMessage && sidechainMessage.tool) {
                            applyToolResultUpdateToReducerMessage({
                                message: sidechainMessage,
                                messageId: sidechainMessageId,
                                toolResult,
                                resultCreatedAt: msg.createdAt,
                                meta: msg.meta,
                                changed,
                            });
                        }
                    }

                    // Also update the main permission message if it exists
                    const permissionMessageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (permissionMessageId) {
                        const permissionMessage = state.messages.get(permissionMessageId);
                        if (permissionMessage && permissionMessage.tool) {
                            applyToolResultUpdateToReducerMessage({
                                message: permissionMessage,
                                messageId: permissionMessageId,
                                toolResult,
                                resultCreatedAt: msg.createdAt,
                                meta: msg.meta,
                                changed,
                            });
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(sidechainId, existingSidechain);

        // Find the Task tool message that owns this sidechain and mark it as changed.
        // Provider-agnostic contract: msg.sidechainId is the originating Task tool-call id.
        if (parentMessageId) {
            changed.add(parentMessageId);
        }
    }
}

