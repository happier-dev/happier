import type { TracedMessage } from '../reducerTracer.js';
import type { ReducerState } from '../reducer.js';
import { applyToolResultUpdateToReducerMessage } from '../helpers/applyToolResultUpdateToReducerMessage.js';
import { bufferOrphanToolResult } from '../helpers/orphanToolResults.js';
import type { ToolResultUpdate } from '../helpers/toolResultUpdateTypes.js';

function toToolResultUpdate(c: Readonly<{
    tool_use_id: string;
    content: unknown;
    is_error: boolean;
    permissions?: ToolResultUpdate['permissions'];
}>): ToolResultUpdate {
    return {
        tool_use_id: c.tool_use_id,
        content: c.content,
        is_error: c.is_error,
        ...(c.permissions ? { permissions: c.permissions } : {}),
    };
}

/** AgentState creates permission-only mirrors with no transcript call identity. */
export function resolveSidechainPermissionMirror(state: ReducerState, toolUseId: string): string | null {
    const messageId = state.toolIdToMessageId.get(toolUseId);
    const message = messageId ? state.messages.get(messageId) : null;
    return message?.realID == null && message?.tool?.permission ? messageId ?? null : null;
}

/** Explicit scope selects its child; an unscoped result requires one current sidechain owner. */
export function resolveSidechainToolMessage(state: ReducerState, toolUseId: string, explicitSidechainId?: string): Readonly<{ messageId: string; sidechainId: string }> | null {
    const candidate = state.sidechainToolIdToMessageId.get(toolUseId);
    if (!candidate && !explicitSidechainId) return null;
    let owner: string | null = null;
    let ownerSidechainId: string | null = null;
    for (const [sidechainId, sidechain] of state.sidechains) {
        if (explicitSidechainId && sidechainId !== explicitSidechainId) continue;
        for (const message of sidechain) {
            if (message.tool?.id !== toolUseId) continue;
            if (owner && owner !== message.id) return null;
            owner = message.id;
            ownerSidechainId = sidechainId;
        }
    }
    return owner && ownerSidechainId ? { messageId: owner, sidechainId: ownerSidechainId } : null;
}

export function runToolResultsPhase(params: Readonly<{
    state: ReducerState;
    nonSidechainMessages: TracedMessage[];
    changed: Set<string>;
}>): void {
    const { state, nonSidechainMessages, changed } = params;

    //
    // Phase 3: Process non-sidechain tool results
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (const [contentIndex, content] of msg.content.entries()) {
                const c = content;
                if (c.type === 'tool-result') {
                    // Find the message containing this tool
                    const mainMessageId = state.toolIdToMessageId.get(c.tool_use_id);
                    const sidechain = mainMessageId ? null : resolveSidechainToolMessage(state, c.tool_use_id);
                    const messageId = mainMessageId ?? sidechain?.messageId;
                    if (!messageId) {
                        const toolResult = toToolResultUpdate(c);
                        bufferOrphanToolResult({
                            state,
                            toolUseId: c.tool_use_id,
                            result: {
                                key: `${msg.id}:${contentIndex}`,
                                createdAt: msg.createdAt,
                                meta: msg.meta,
                                toolResult,
                            },
                        });
                        continue;
                    }

                    let message = state.messages.get(messageId);
                    if (!message || !message.tool) {
                        continue;
                    }
                    const toolResult = toToolResultUpdate(c);
                    applyToolResultUpdateToReducerMessage({
                        message,
                        messageId,
                        toolResult,
                        resultCreatedAt: msg.createdAt,
                        meta: msg.meta,
                        changed,
                    });
                    if (sidechain) {
                        const parentId = state.toolIdToMessageId.get(sidechain.sidechainId);
                        if (parentId) changed.add(parentId);
                    }
                }
            }
        }
    }
}
