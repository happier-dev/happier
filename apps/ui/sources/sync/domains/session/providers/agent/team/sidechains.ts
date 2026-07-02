import { isAgentTeamSubagentSpawnToolName } from './descriptor';
import type { AgentTeamMessage, AgentTeamSessionProviderDescriptor, AgentTeamToolCallMessage } from './types';
import {
    deriveAgentTeamSpawnedTeammateFromTaskToolInput,
    deriveAgentTeamSpawnedTeammateFromTaskToolResult,
} from './participants';

export function deriveAgentTeamSidechainIds(params: Readonly<{
    descriptor: AgentTeamSessionProviderDescriptor;
    messages: readonly AgentTeamMessage[];
}>): readonly string[] {
    const sidechainIds = new Set<string>();

    for (const message of params.messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as AgentTeamToolCallMessage;
        const toolName = toolMessage.tool?.name;
        if (!isAgentTeamSubagentSpawnToolName(params.descriptor, toolName)) continue;

        const spawned =
            deriveAgentTeamSpawnedTeammateFromTaskToolResult(toolMessage.tool.result)
            ?? deriveAgentTeamSpawnedTeammateFromTaskToolInput(toolMessage.tool.input);
        if (!spawned) continue;

        const toolId = typeof toolMessage.tool?.id === 'string' ? toolMessage.tool.id.trim() : '';
        if (!toolId) continue;
        sidechainIds.add(toolId);
    }

    return Array.from(sidechainIds.values());
}
