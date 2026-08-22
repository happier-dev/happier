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
): string {
    return resolveAgentIdFromFlavor(flavor) ?? readDeclaredAgentId(flavor) ?? fallback;
}

function readDeclaredAgentId(value: string | null | undefined): string | null {
    const agentId = typeof value === 'string' ? value.trim() : '';
    return agentId.length > 0 ? agentId : null;
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
}): string {
    const byMetadata = resolveAgentIdFromSessionMetadata(params.metadata);
    if (byMetadata) return byMetadata;

    const byFlavor = resolveAgentIdFromFlavor(params.flavor);
    if (byFlavor) return byFlavor;

    // A non-empty foreign flavor is still the session's declared Agent
    // identity. Preserve it so neutral/unavailable UI is selected rather than
    // borrowing a bundled Agent's tool behavior or default presentation.
    const declaredFlavor = readDeclaredAgentId(params.flavor);
    if (declaredFlavor) return declaredFlavor;

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
