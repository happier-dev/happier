import { randomUUID } from 'node:crypto';

import type { RawJSONLines } from '@/backends/claude/types';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';

import { ClaudeTurnChangeTracker } from './ClaudeTurnChangeTracker';
import { isClaudeExplicitDiffToolInput } from './isClaudeExplicitDiffToolInput';

type SendRawMessage = (message: RawJSONLines) => void;
type AssistantRawJSONLine = Extract<RawJSONLines, { type: 'assistant' }>;
type UserRawJSONLine = Extract<RawJSONLines, { type: 'user' }>;

function filterAssistantContent(params: Readonly<{
    message: AssistantRawJSONLine;
    turnChangeTracker: ClaudeTurnChangeTracker;
    suppressedExplicitDiffCallIds: Set<string>;
}>): AssistantRawJSONLine {
    const content = Array.isArray((params.message as any)?.message?.content)
        ? ((params.message as any).message.content as ReadonlyArray<Record<string, unknown>>)
        : [];
    if (content.length === 0) {
        return params.message;
    }

    const filteredContent = content.filter((block) => {
        if (!block || typeof block !== 'object') return false;
        if (block.type !== 'tool_use') return true;

        const callId = typeof block.id === 'string' ? block.id : '';
        const toolName = typeof block.name === 'string' ? block.name : '';
        const args = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? block.input as Record<string, unknown>
            : {};

        if (callId && toolName && (params.message as any).isSidechain !== true) {
            params.turnChangeTracker.observeToolCall({
                callId,
                toolName,
                args,
                parentToolUseId: null,
            });
        }

        if (callId && isClaudeExplicitDiffToolInput(toolName, args)) {
            params.suppressedExplicitDiffCallIds.add(callId);
            return false;
        }

        return true;
    });

    if (filteredContent.length === content.length) {
        return params.message;
    }

    return {
        ...(params.message as any),
        message: {
            ...((params.message as any).message ?? {}),
            content: filteredContent,
        },
    } as AssistantRawJSONLine;
}

function filterUserContent(params: Readonly<{
    message: UserRawJSONLine;
    turnChangeTracker: ClaudeTurnChangeTracker;
    suppressedExplicitDiffCallIds: Set<string>;
}>): UserRawJSONLine {
    const content = Array.isArray((params.message as any)?.message?.content)
        ? ((params.message as any).message.content as ReadonlyArray<Record<string, unknown>>)
        : [];
    if (content.length === 0) {
        return params.message;
    }

    const filteredContent = content.filter((block) => {
        if (!block || typeof block !== 'object') return false;
        if (block.type !== 'tool_result') return true;

        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (!callId || (params.message as any).isSidechain === true) {
            return true;
        }

        const isError = block.is_error === true;
        params.turnChangeTracker.observeToolResult({
            callId,
            isError,
            toolUseResult: (params.message as any).toolUseResult,
        });

        if (isError) {
            params.suppressedExplicitDiffCallIds.delete(callId);
            return true;
        }

        return !params.suppressedExplicitDiffCallIds.has(callId);
    });

    if (filteredContent.length === content.length) {
        return params.message;
    }

    return {
        ...(params.message as any),
        message: {
            ...((params.message as any).message ?? {}),
            content: filteredContent,
        },
    } as UserRawJSONLine;
}

function sendSyntheticToolUse(params: Readonly<{
    callId: string;
    toolName: string;
    input: unknown;
    sendMessage: SendRawMessage;
}>): void {
    params.sendMessage({
        type: 'assistant',
        uuid: randomUUID(),
        isSidechain: false,
        message: {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: params.callId,
                    name: params.toolName,
                    input: params.input,
                },
            ],
        },
    } as RawJSONLines);
}

function sendSyntheticToolResult(params: Readonly<{
    callId: string;
    output: unknown;
    sendMessage: SendRawMessage;
}>): void {
    params.sendMessage({
        type: 'user',
        uuid: randomUUID(),
        isSidechain: false,
        message: {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: params.callId,
                    content: params.output,
                    is_error: false,
                },
            ],
        },
    } as RawJSONLines);
}

export function createClaudeRawMessageTurnDiffBridge(params: Readonly<{
    getSessionId: () => string;
    sendMessage: SendRawMessage;
}>) {
    const turnChangeTracker = new ClaudeTurnChangeTracker();
    const suppressedExplicitDiffCallIds = new Set<string>();
    let shouldFlushAfterForward = false;

    function completeTurn(): void {
        const turnChangeSet = turnChangeTracker.completeTurn({
            sessionId: params.getSessionId(),
            status: 'completed',
        });
        if (turnChangeSet) {
            emitCanonicalTurnDiffTool({
                turnChangeSet,
                protocol: 'claude',
                rawToolName: 'ClaudeTurnDiff',
                sendToolCall: ({ toolName, input, callId }) => {
                    const resolvedCallId = callId ?? randomUUID();
                    sendSyntheticToolUse({
                        callId: resolvedCallId,
                        toolName,
                        input,
                        sendMessage: params.sendMessage,
                    });
                    return resolvedCallId;
                },
                sendToolResult: ({ callId, output }) => {
                    sendSyntheticToolResult({
                        callId,
                        output,
                        sendMessage: params.sendMessage,
                    });
                },
            });
        }
        suppressedExplicitDiffCallIds.clear();
    }

    return {
        observe(message: RawJSONLines): RawJSONLines | null {
            shouldFlushAfterForward = false;
            if (message.type === 'summary') {
                completeTurn();
                return null;
            }

            if (message.type === 'assistant') {
                const nextMessage = filterAssistantContent({
                    message,
                    turnChangeTracker,
                    suppressedExplicitDiffCallIds,
                });
                const stopReason = typeof (message as any)?.message?.stop_reason === 'string'
                    ? String((message as any).message.stop_reason)
                    : '';
                if ((message as any).isSidechain !== true && stopReason === 'end_turn') {
                    shouldFlushAfterForward = true;
                }
                return nextMessage;
            }

            if (message.type === 'user') {
                return filterUserContent({
                    message,
                    turnChangeTracker,
                    suppressedExplicitDiffCallIds,
                });
            }

            return message;
        },
        flushAfterForwardIfNeeded(): void {
            if (!shouldFlushAfterForward) {
                return;
            }
            shouldFlushAfterForward = false;
            completeTurn();
        },
        reset(): void {
            turnChangeTracker.resetTurn();
            suppressedExplicitDiffCallIds.clear();
            shouldFlushAfterForward = false;
        },
    };
}
