import { isDeepStrictEqual } from 'node:util';

import { extractAgentIdFromTaskResultText } from '@happier-dev/plugins-claude/agent';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '../sdk';

import { coerceClaudeToolResultText } from './permissionToolInput';
import { isInteractiveTool, type PermissionResponse } from './permissionCore';

type ToolCallEntry = {
    id: string;
    name: string;
    input: unknown;
    used: boolean;
};

export class ClaudePermissionToolCallLedger {
    private toolCalls: ToolCallEntry[] = [];
    private responses = new Map<string, PermissionResponse>();
    private agentIdByTaskId = new Map<string, string>();

    getAgentIdByTaskId(): ReadonlyMap<string, string> {
        return this.agentIdByTaskId;
    }

    notePermissionResponse(message: PermissionResponse): void {
        this.responses.set(message.id, { ...message, receivedAt: Date.now() } as PermissionResponse);
    }

    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }

    resolveToolCallId(name: string, args: unknown): string | null {
        for (let i = this.toolCalls.length - 1; i >= 0; i--) {
            const call = this.toolCalls[i];
            if (call.name === name && isDeepStrictEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                call.used = true;
                return call.id;
            }
        }

        return null;
    }

    onMessage(message: SDKMessage): void {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        this.toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false,
                        });
                    }
                }
            }
        }

        if (message.type !== 'user') return;

        const userMsg = message as SDKUserMessage;
        if (!userMsg.message || !Array.isArray(userMsg.message.content)) return;

        for (const block of userMsg.message.content) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;

            const toolCall = this.toolCalls.find((entry) => entry.id === block.tool_use_id);
            if (toolCall && !toolCall.used) {
                toolCall.used = true;
            }
            if (!toolCall || (toolCall.name !== 'task' && !isGenericSubAgentToolName(toolCall.name))) {
                continue;
            }

            const text = coerceClaudeToolResultText((block as any).content);
            const ids = extractAgentIdFromTaskResultText(text);
            if (ids.agentId && ids.taskId) {
                this.agentIdByTaskId.set(ids.taskId, ids.agentId);
            }
        }
    }

    isAborted(toolCallId: string): boolean {
        const toolCall = this.toolCalls.find((entry) => entry.id === toolCallId);
        if (toolCall && isInteractiveTool(toolCall.name)) {
            return false;
        }

        return this.responses.get(toolCallId)?.approved === false;
    }

    reset(): void {
        this.toolCalls = [];
        this.responses.clear();
        this.agentIdByTaskId.clear();
    }
}
