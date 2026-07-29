import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { AgentId } from '@/agents/registry/registryCore';
import {
    AGENT_IDS,
    DEFAULT_AGENT_ID,
    getAgentCore,
    resolveAgentIdFromFlavor,
} from '@/agents/registry/registryCore';

export function resolveAgentIdOrDefault(
    flavor: string | null | undefined,
    fallback: AgentId,
): AgentId {
    return resolveAgentIdFromFlavor(flavor) ?? fallback;
}

/**
 * Permission prompts can arrive without reliable `metadata.flavor`, especially when
 * older daemons/agents emit tool names that encode the agent (e.g. `CodexBash`).
 *
 * This helper centralizes those heuristics.
 */
export function resolveAgentIdForPermissionUi(params: {
    metadata?: unknown;
    flavor: string | null | undefined;
    toolName: string;
}): AgentId {
    const byMetadata = resolveAgentIdFromSessionMetadata(params.metadata);
    if (byMetadata) return byMetadata;

    const byFlavor = resolveAgentIdFromFlavor(params.flavor);
    if (byFlavor) return byFlavor;

    const byTool = typeof params.toolName === 'string' ? params.toolName.trim() : '';
    if (byTool.length > 0) {
        const normalizedTool = byTool.toLowerCase();
        for (const agentId of AGENT_IDS) {
            const detectKey = getAgentCore(agentId).cli.detectKey.trim().toLowerCase();
            if (detectKey.length > 0 && normalizedTool.startsWith(detectKey)) {
                return agentId;
            }
        }
    }
    return DEFAULT_AGENT_ID;
}
