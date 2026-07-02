import type { TracedMessage } from '../reducerTracer';
import type { ReducerState } from '../reducer';
import { applyToolResultUpdateToReducerMessage } from '../helpers/applyToolResultUpdateToReducerMessage';
import { bufferOrphanToolResult } from '../helpers/orphanToolResults';
import type { ToolResultUpdate } from '../helpers/toolResultUpdateTypes';

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
                    let messageId = state.toolIdToMessageId.get(c.tool_use_id);
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
                }
            }
        }
    }
}
