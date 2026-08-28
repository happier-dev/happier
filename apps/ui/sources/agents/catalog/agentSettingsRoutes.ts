import {
    BackendTargetKeyV2Schema,
    PluginContributionIdentityV1Schema,
    buildBackendTargetKeyV2,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { isBundledAgentId } from '@happier-dev/agents';

import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '../registry/generatedBundledPluginEntries';

export function createPluginAgentSettingsRoute(agent: PluginContributionIdentityV1): string {
    return `/(app)/settings/agents/${encodeURIComponent(agent.localId)}?pluginId=${encodeURIComponent(agent.pluginId)}`;
}

/** The one Agent-detail route owner; projected Agents retain exact plugin identity. */
export function createAgentSettingsRoute(agent: Readonly<{
    agentId: string;
    identity: PluginContributionIdentityV1 | null;
}>): string {
    return agent.identity
        ? createPluginAgentSettingsRoute(agent.identity)
        : `/(app)/settings/agents/${encodeURIComponent(agent.agentId)}`;
}

/** Resolve the exact Agent target carried by the models settings route. */
export function resolveAgentModelsTargetKey(params: Readonly<{
    agentId: string;
    pluginId?: string;
    agentTargetKey?: string;
}>): string {
    const explicit = BackendTargetKeyV2Schema.safeParse(params.agentTargetKey?.trim());
    if (explicit.success) return explicit.data;

    const agentId = params.agentId.trim();
    const qualifiedIdentity = PluginContributionIdentityV1Schema.safeParse({
        pluginId: params.pluginId?.trim(),
        localId: agentId,
    });
    if (qualifiedIdentity.success) {
        return buildBackendTargetKeyV2({ kind: 'agent', identity: qualifiedIdentity.data });
    }
    if (isBundledAgentId(agentId)) {
        return buildBackendTargetKeyV2({
            kind: 'agent',
            identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES[agentId],
        });
    }

    // Preserve the pre-existing unqualified fallback only for identities the
    // current catalog cannot qualify. Bundled and qualified plugin Agents never
    // enter this path.
    return `backend:${agentId}`;
}
