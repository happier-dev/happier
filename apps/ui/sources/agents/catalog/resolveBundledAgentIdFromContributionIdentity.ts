import { AGENT_IDS, BUNDLED_AGENT_CONTRIBUTION_IDENTITIES, type BundledAgentId } from '@happier-dev/agents/agent-ids';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';

/** Exact generated package identity; never infer an Agent from a namespace or backing Agent. */
export function resolveBundledAgentIdFromPluginId(pluginId: string | null | undefined): BundledAgentId | null {
    return AGENT_IDS.find((agentId) => BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId].pluginId === pluginId) ?? null;
}

export function resolveBundledAgentIdFromContributionIdentity(identity: unknown): BundledAgentId | null {
    const parsed = PluginContributionIdentityV1Schema.safeParse(identity);
    if (!parsed.success) return null;
    for (const agentId of AGENT_IDS) {
        const bundledIdentity = BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId];
        if (bundledIdentity.pluginId === parsed.data.pluginId && bundledIdentity.localId === parsed.data.localId) {
            return agentId;
        }
    }
    return null;
}
