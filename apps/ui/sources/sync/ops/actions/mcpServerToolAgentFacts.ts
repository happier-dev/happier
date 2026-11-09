import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { McpServerToolAgentFactV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';

/** Data-only facts from the same admitted daemon declaration the tools Action reads. */
export function readMcpServerToolAgentFacts(
    projection: PluginProjectionV2,
    installedAgentIds: readonly string[],
): readonly McpServerToolAgentFactV1[] {
    const installed = new Set(installedAgentIds);
    return Object.keys(projection.agentsById).flatMap(agentId => {
        if (!installed.has(agentId)) return [];
        const current = readCurrentProjectedAgentCapabilities({ projection, agentId });
        if (!current) return [];
        const tools = current.capabilities.tools;
        return [{ agentId: current.agentId,
            ...(tools?.mcpToolControl === undefined ? {} : { mcpToolControl: tools.mcpToolControl }),
            ...(tools?.mcpToolLoading === undefined ? {} : { mcpToolLoading: tools.mcpToolLoading }),
        }];
    });
}
