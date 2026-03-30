import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

import {
    deriveClaudeSpawnedTeammateFromTaskToolInput,
    deriveClaudeSpawnedTeammateFromTaskToolResult,
} from './deriveClaudeTeamParticipants';

export function deriveClaudeTeamSidechainIds(params: Readonly<{ messages: readonly Message[] }>): readonly string[] {
    const sidechainIds = new Set<string>();

    for (const message of params.messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        const toolName = toolMessage.tool?.name;
        if (!isGenericSubAgentToolName(toolName ?? '')) continue;

        const spawned =
            deriveClaudeSpawnedTeammateFromTaskToolResult(toolMessage.tool.result)
            ?? deriveClaudeSpawnedTeammateFromTaskToolInput(toolMessage.tool.input);
        if (!spawned) continue;

        const toolId = typeof toolMessage.tool?.id === 'string' ? toolMessage.tool.id.trim() : '';
        if (!toolId) continue;
        sidechainIds.add(toolId);
    }

    return Array.from(sidechainIds.values());
}
