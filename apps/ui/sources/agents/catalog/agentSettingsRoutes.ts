import { BackendTargetKeyV2Schema, buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { isBundledAgentId } from '@happier-dev/agents';

import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';

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

const CUSTOM_ACP_AGENTS_ROUTE = '/(app)/settings/agents/custom';
const CUSTOM_ACP_AGENT_PATHNAME = /^\/settings\/agents\/custom(?:\/([^/]+))?\/?$/;

/**
 * A custom ACP agent inside the Agents collection: the new-agent draft (no id) or a saved agent.
 * No bundled agent is called `custom`; a plugin agent whose local id is `custom` would be shadowed
 * by this static segment.
 */
export function createCustomAcpAgentSettingsRoute(backendId: string | null): string {
    return backendId ? `${CUSTOM_ACP_AGENTS_ROUTE}/${encodeURIComponent(backendId)}` : CUSTOM_ACP_AGENTS_ROUTE;
}

/** Which custom ACP agent a collection pathname shows, if any. */
export function resolveCustomAcpAgentRoute(pathname: string):
    | Readonly<{ kind: 'draft' }>
    | Readonly<{ kind: 'saved'; backendId: string }>
    | null {
    const match = CUSTOM_ACP_AGENT_PATHNAME.exec(pathname);
    if (!match) return null;
    return match[1] ? { kind: 'saved', backendId: decodeURIComponent(match[1]) } : { kind: 'draft' };
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
            identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId],
        });
    }

    // Preserve the pre-existing unqualified fallback only for identities the
    // current catalog cannot qualify. Bundled and qualified plugin Agents never
    // enter this path.
    return `backend:${agentId}`;
}
