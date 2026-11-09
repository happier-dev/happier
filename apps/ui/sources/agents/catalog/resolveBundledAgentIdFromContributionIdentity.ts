import { AGENT_IDS, BUNDLED_AGENT_CONTRIBUTION_IDENTITIES, type BundledAgentId } from '@happier-dev/agents/agent-ids';
export { resolveBundledAgentIdFromContributionIdentity } from '@happier-dev/agents';

/** Exact generated package identity; never infer an Agent from a namespace or backing Agent. */
export function resolveBundledAgentIdFromPluginId(pluginId: string | null | undefined): BundledAgentId | null {
    return AGENT_IDS.find((agentId) => BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId].pluginId === pluginId) ?? null;
}
