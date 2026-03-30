import { buildToolCallMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readSubagentMetadata(toolMessage: ToolCallMessage): Readonly<{
    description: string | null;
    prompt: string | null;
    subagentType: string | null;
}> {
    const input = asRecord(toolMessage.tool.input);
    const metadata = asRecord(input?.metadata);

    return {
        description:
            readNonEmptyString(input?.description)
            ?? readNonEmptyString(metadata?.description)
            ?? readNonEmptyString(toolMessage.tool.description)
            ?? null,
        prompt:
            readNonEmptyString(input?.prompt)
            ?? readNonEmptyString(metadata?.prompt)
            ?? null,
        subagentType:
            readNonEmptyString(input?.subagent_type)
            ?? readNonEmptyString(metadata?.subagent_type)
            ?? null,
    };
}

function isPendingPermissionSubagentMessage(message: Message): message is ToolCallMessage {
    if (message.kind !== 'tool-call') return false;

    const pendingPermission = message.tool.permission?.status === 'pending';
    if (!pendingPermission) return false;

    const rawToolName = readNonEmptyString(message.tool.name)?.toLowerCase() ?? '';
    if (rawToolName === 'task' || rawToolName === 'agent' || rawToolName === 'subagent') {
        return true;
    }

    if (isGenericSubAgentToolName(message.tool.name)) {
        return true;
    }

    const { subagentType } = readSubagentMetadata(message);
    return subagentType !== null;
}

function messagesMatchBySubagentMetadata(left: ToolCallMessage, right: ToolCallMessage): boolean {
    const leftMeta = readSubagentMetadata(left);
    const rightMeta = readSubagentMetadata(right);

    if (leftMeta.prompt && rightMeta.prompt && leftMeta.prompt === rightMeta.prompt) {
        return true;
    }

    if (leftMeta.description && rightMeta.description && leftMeta.description === rightMeta.description) {
        if (!leftMeta.subagentType || !rightMeta.subagentType) return true;
        return leftMeta.subagentType === rightMeta.subagentType;
    }

    return false;
}

export function resolvePendingPermissionRouteForSubAgentTool(params: Readonly<{
    messages: readonly Message[];
    toolMessage: ToolCallMessage;
}>): string | null {
    let bestMatch: ToolCallMessage | null = null;

    for (const message of params.messages) {
        if (!isPendingPermissionSubagentMessage(message)) continue;
        if (!messagesMatchBySubagentMetadata(message, params.toolMessage)) continue;

        if (!bestMatch || message.createdAt > bestMatch.createdAt) {
            bestMatch = message;
        }
    }

    if (!bestMatch) return null;

    return buildToolCallMessageRouteId({
        toolId: typeof bestMatch.tool.id === 'string' ? bestMatch.tool.id : null,
        fallbackMessageId: bestMatch.id,
    });
}
