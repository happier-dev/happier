import { AGENT_CORE_CONFIGS, DEFAULT_AGENT_ID, type AgentId } from '@/agents/catalog/catalog';

export function listMcpPreviewAgentIds(): readonly AgentId[] {
    return AGENT_CORE_CONFIGS.filter((core) => core.tools.delivery !== 'unsupported').map((core) => core.id);
}

export function getPreferredMcpPreviewAgentId(
    agentIds: readonly AgentId[],
    currentSelection: string | null | undefined,
): AgentId {
    if (typeof currentSelection === 'string') {
        const normalizedSelection = currentSelection.trim();
        if (agentIds.includes(normalizedSelection as AgentId)) {
            return normalizedSelection as AgentId;
        }
    }

    return agentIds[0] ?? DEFAULT_AGENT_ID;
}
