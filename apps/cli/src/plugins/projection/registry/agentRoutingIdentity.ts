import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';

import type {
    ResolvedAgentContribution,
    ResolvedContributionProvenance,
} from './types';

/**
 * Resolves the host routing id for one contributed Agent.
 *
 * Durable Agent identity is `{pluginId, localId}`. Two independently authored
 * plugins may legitimately declare the same natural local id — `assistant` is
 * the obvious example — so the routing id an installed Agent is keyed, looked
 * up, selected and dispatched by has to carry the owning Plugin id as well.
 *
 * Bundled first-party Agents keep their unqualified released identifier: those
 * ids already travel in persisted Sessions, CLI subcommands and wire targets,
 * and the bundled set is generated, closed and collision-free. That is the one
 * boundary concession, not an alias table: nothing maps a qualified identity
 * back onto a different Agent's id.
 */
export function resolveContributedAgentRoutingId(params: Readonly<{
    pluginId: string;
    localId: string;
    provenance: ResolvedContributionProvenance;
}>): string {
    return params.provenance === 'first_party'
        ? params.localId
        : buildQualifiedPluginContributionKey({
            pluginId: params.pluginId,
            localId: params.localId,
        });
}

/**
 * Resolves the qualified Plugin contribution key for one contributed Agent:
 * the always-qualified `"<pluginId>/agents/<localId>"` spelling carried by activation
 * and managed-service authority bindings (`qualifiedAgentId`,
 * `contributionQualifiedId`).
 *
 * This is a distinct fact from {@link resolveContributedAgentRoutingId}: the
 * routing id is how the host addresses the Agent (unqualified for bundled
 * first-party Agents), while the qualified contribution key always carries the
 * owning Plugin id. Runner bindings carry both facts plus the structured
 * `{pluginId, localId}` identity fields; no spelling maps one onto the other.
 */
export function resolveAgentContributionQualifiedId(params: Readonly<{
    pluginId: string;
    localId: string;
}>): string {
    return `${params.pluginId}/agents/${encodeURIComponent(params.localId)}`;
}

/**
 * Indexes selected Agent contributions by their durable `{pluginId, localId}`
 * identity so identity-addressed consumers resolve the same routing id the
 * projection assigned, instead of re-deriving one.
 */
export function indexAgentRoutingIdsByContributionIdentity(
    agents: readonly Pick<ResolvedAgentContribution, 'id' | 'identity' | 'pluginId'>[],
): ReadonlyMap<string, string> {
    const routingIdsByIdentityKey = new Map<string, string>();
    for (const agent of agents) {
        const pluginId = agent.identity?.pluginId ?? agent.pluginId;
        if (!pluginId) continue;
        routingIdsByIdentityKey.set(
            buildQualifiedPluginContributionKey({
                pluginId,
                localId: agent.identity?.localId ?? agent.id,
            }),
            agent.id,
        );
    }
    return routingIdsByIdentityKey;
}

/** Resolves the routing id one durable Agent identity currently addresses. */
export function readAgentRoutingIdForContributionIdentity(
    routingIdsByIdentityKey: ReadonlyMap<string, string>,
    identity: Readonly<{ pluginId: string; localId: string }>,
): string | null {
    return routingIdsByIdentityKey.get(buildQualifiedPluginContributionKey(identity)) ?? null;
}
