import type { TracedMessage } from '../reducerTracer';
import type { ReducerState } from '../reducer';
import { coerceStreamingToolResultChunk, mergeExistingStdStreamsIntoFinalResultIfMissing, mergeStreamingChunkIntoResult } from '../helpers/streamingToolResult';

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
            for (let c of msg.content) {
                if (c.type === 'tool-result') {
                    // Find the message containing this tool
                    let messageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (!messageId) {
                        continue;
                    }

                    let message = state.messages.get(messageId);
                    if (!message || !message.tool) {
                        continue;
                    }

                    // Tool results can race: we can receive a permission completion (creating a "permission-only" tool)
                    // and then later receive the actual tool_result without ever seeing a tool_call (dropped update,
                    // reconnect/resume, etc). In that case we must allow the real tool output to overwrite placeholders
                    // like "Approved".
                    const isApprovedPlaceholder =
                        message.tool.state === 'completed' &&
                        message.tool.result === 'Approved' &&
                        message.tool.permission?.status === 'approved';

                    if (message.tool.state !== 'running' && !isApprovedPlaceholder) {
                        continue;
                    }

                    if (isApprovedPlaceholder) {
                        message.tool.state = 'running';
                        message.tool.completedAt = null;
                        message.tool.result = undefined;
                    }

                    const streamChunk = coerceStreamingToolResultChunk(c.content);
                    if (streamChunk) {
                        message.tool.result = mergeStreamingChunkIntoResult(message.tool.result, streamChunk);
                        changed.add(messageId);
                        continue;
                    }

                    // Update tool state and result
                    message.tool.state = c.is_error ? 'error' : 'completed';
                    message.tool.result = mergeExistingStdStreamsIntoFinalResultIfMissing(message.tool.result, c.content);
                    message.tool.completedAt = msg.createdAt;

                    // Update permission data if provided by backend
                    if (c.permissions) {
                        // Merge with existing permission to preserve decision field from agentState
                        if (message.tool.permission) {
                            // Preserve existing decision if not provided in tool result
                            const existingDecision = message.tool.permission.decision;
                            message.tool.permission = {
                                ...message.tool.permission,
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision || existingDecision
                            };
                        } else {
                            message.tool.permission = {
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision
                            };
                        }
                    }

                    changed.add(messageId);
                }
            }
        }
    }
}
