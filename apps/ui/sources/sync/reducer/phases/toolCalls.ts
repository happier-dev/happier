import type { TracedMessage } from '../reducerTracer';
import type { ToolCall } from '../../domains/messages/messageTypes';
import { compareToolCalls } from '../../../utils/tools/toolComparison';
import type { ReducerState } from '../reducer';
import { drainAndApplyOrphanToolResultsToMessage } from '../helpers/drainAndApplyOrphanToolResultsToMessage';
import { setThinkingMergeCursor } from '../helpers/mergeCursors';
import { normalizeTranscriptSeq, transcriptBlockIndexFromContentIndex } from '../../domains/messages/transcriptOrdering';
import { createTranscriptToolCallProjection } from '../helpers/toolCallProjection';

function readRuntimeFullToolSnapshotKind(message: TracedMessage): 'tool-progress' | 'tool-call' | null {
    const meta = message.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const record = meta as Record<string, unknown>;
    if (record.source !== 'runtime') return null;
    const snapshot = record.runtimeToolSnapshotV1;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const snapshotRecord = snapshot as Record<string, unknown>;
    if (snapshotRecord.v !== 1 || snapshotRecord.mode !== 'full') return null;
    return record.runtimeEventKind === 'tool-progress' || record.runtimeEventKind === 'tool-call'
        ? record.runtimeEventKind
        : null;
}

function applyRuntimeTerminalToolSnapshotState(tool: ToolCall, input: unknown, completedAt: number): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const acp = (input as Record<string, unknown>)._acp;
    if (!acp || typeof acp !== 'object' || Array.isArray(acp)) return;
    const status = (acp as Record<string, unknown>).status;
    if (status === 'completed') {
        tool.state = 'completed';
    } else if (status === 'failed' || status === 'cancelled') {
        tool.state = 'error';
    } else {
        return;
    }
    tool.completedAt = completedAt;
}

export function runToolCallsPhase(params: Readonly<{
    state: ReducerState;
    nonSidechainMessages: TracedMessage[];
    changed: Set<string>;
    allocateId: () => string;
    enableLogging: boolean;
    isPermissionRequestToolCall: (toolId: string, input: unknown) => boolean;
}>): void {
    const {
        state,
        nonSidechainMessages,
        changed,
        allocateId,
        enableLogging,
        isPermissionRequestToolCall,
    } = params;

    //
    // Phase 2: Process non-sidechain tool calls
    //

    if (enableLogging) {
        console.log(`[REDUCER] Phase 2: Processing tool calls`);
    }
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let contentIndex = 0; contentIndex < msg.content.length; contentIndex += 1) {
                const c = msg.content[contentIndex]!;
                if (c.type === 'tool-call') {
                    const transcriptBlockIndex = transcriptBlockIndexFromContentIndex(contentIndex);
                    // Direct lookup by tool ID (since permission ID = tool ID now)
                    const existingMessageId = state.toolIdToMessageId.get(c.id);

                    if (existingMessageId != null) {
                        if (enableLogging) {
                            console.log(`[REDUCER] Found existing message for tool ${c.id}`);
                        }
                        // Update existing message with tool execution details
                        const message = state.messages.get(existingMessageId);
                        if (message?.tool) {
                            message.realID = msg.id;
                            const runtimeSnapshotKind = readRuntimeFullToolSnapshotKind(msg);
                            const incomingSeq = normalizeTranscriptSeq(msg.seq);
                            if (
                                incomingSeq !== null
                                && (
                                    message.seq === null
                                    || (
                                        runtimeSnapshotKind === 'tool-call'
                                        && incomingSeq > message.seq
                                    )
                                )
                            ) {
                                message.seq = incomingSeq;
                            }
                            if (message.transcriptBlockIndex == null) {
                                message.transcriptBlockIndex = transcriptBlockIndex;
                            }
                            state.messageIds.set(msg.id, existingMessageId);
                            if (!message.tool.id) {
                                message.tool.id = c.id;
                            }
                            if (typeof c.name === 'string' && c.name.length > 0 && message.tool.name !== c.name) {
                                message.tool.name = c.name;
                            }
                            message.tool.description = c.description;

                            // Merge updated tool input (ACP providers can send late-arriving titles, locations,
                            // or rawInput in subsequent tool_call updates).
                            const incomingInput = c.input;
                            if (incomingInput !== undefined) {
                                const existingInput = message.tool.input;
                                const existingObj = existingInput && typeof existingInput === 'object' && !Array.isArray(existingInput)
                                    ? (existingInput as Record<string, unknown>)
                                    : null;
                                const incomingObj = incomingInput && typeof incomingInput === 'object' && !Array.isArray(incomingInput)
                                    ? (incomingInput as Record<string, unknown>)
                                    : null;

                                const merged = runtimeSnapshotKind !== null
                                    ? incomingInput
                                    : existingObj && incomingObj
                                        ? (() => {
                                            // Preserve existing fields (permission args are authoritative), but allow
                                            // ACP metadata (_acp) to update over time.
                                            const base = { ...incomingObj, ...existingObj };
                                            const existingAcp = existingObj._acp && typeof existingObj._acp === 'object' && !Array.isArray(existingObj._acp)
                                                ? (existingObj._acp as Record<string, unknown>)
                                                : null;
                                            const incomingAcp = incomingObj._acp && typeof incomingObj._acp === 'object' && !Array.isArray(incomingObj._acp)
                                                ? (incomingObj._acp as Record<string, unknown>)
                                                : null;
                                            if (incomingAcp) {
                                                base._acp = { ...(existingAcp ?? {}), ...incomingAcp };
                                            }
                                            return base;
                                        })()
                                        : incomingInput;

                                const inputUnchanged = compareToolCalls(
                                    { name: c.name, arguments: existingInput },
                                    { name: c.name, arguments: merged }
                                );
                                if (!inputUnchanged) {
                                    message.tool.input = merged;
                                }
                            }

                            const isPendingPermissionRequest = isPermissionRequestToolCall(c.id, message.tool.input);
                            if (isPendingPermissionRequest) {
                                if (!message.tool.permission) {
                                    message.tool.permission = { id: c.id, status: 'pending' };
                                }
                                message.tool.startedAt = null;
                            } else {
                                message.tool.startedAt = msg.createdAt;
                            }

                            // If permission was approved and shown as completed (no tool), now it's running
                            if (message.tool.permission?.status === 'approved' && message.tool.state === 'completed') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                message.tool.result = undefined;
                            }
                            if (runtimeSnapshotKind === 'tool-call') {
                                applyRuntimeTerminalToolSnapshotState(message.tool, message.tool.input, msg.createdAt);
                            }
                            changed.add(existingMessageId);

                            // Track TodoWrite tool inputs when updating existing messages
                            if (message.tool.name === 'TodoWrite' && message.tool.state === 'running' && message.tool.input?.todos) {
                                // Only update if this is newer than existing todos
                                if (!state.latestTodos || message.tool.createdAt > state.latestTodos.timestamp) {
                                    state.latestTodos = {
                                        todos: message.tool.input.todos,
                                        timestamp: message.tool.createdAt
                                    };
                                }
                            }
                        }
                    } else {
                        if (enableLogging) {
                            console.log(`[REDUCER] Creating new message for tool ${c.id}`);
                        }
                        const permission = state.permissions.get(c.id);
                        if (permission && enableLogging) {
                            console.log(`[REDUCER] Found stored permission for tool ${c.id}`);
                        }
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
                        if (readRuntimeFullToolSnapshotKind(msg) === 'tool-call') {
                            applyRuntimeTerminalToolSnapshotState(toolCall, c.input, msg.createdAt);
                        }

                        // Some providers persist pending permission requests as tool-call messages (without AgentState).
                        // Treat those tool-call inputs as pending permissions so the UI can render approval controls.
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
		                            tool: toolCall,
	                            event: null,
	                            meta: msg.meta,
	                        });
                        state.messageIds.set(msg.id, mid);
	                        setThinkingMergeCursor(state, null, 'tool-call-phase');

                        state.toolIdToMessageId.set(c.id, mid);
                        changed.add(mid);

                        drainAndApplyOrphanToolResultsToMessage({
                            state,
                            toolUseId: c.id,
                            messageId: mid,
                            changed,
                        });

                        // Track TodoWrite tool inputs
                        if (toolCall.name === 'TodoWrite' && toolCall.state === 'running' && toolCall.input?.todos) {
                            // Only update if this is newer than existing todos
                            if (!state.latestTodos || toolCall.createdAt > state.latestTodos.timestamp) {
                                state.latestTodos = {
                                    todos: toolCall.input.todos,
                                    timestamp: toolCall.createdAt
                                };
                            }
                        }
                    }
                }
            }
        }
    }
}
