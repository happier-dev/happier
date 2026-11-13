import {
  buildQualifiedPluginContributionKey,
  parseQualifiedPluginContributionKey,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol/plugins/contribution-identity';

export type AgentRoutingIdentityEntry = Readonly<{
  id: string;
  identity?: PluginContributionIdentityV1 | null;
  pluginId?: string;
}>;

/** Index the routing ids assigned by the host, without deriving ids from local names. */
export function indexAgentRoutingIdsByContributionIdentity(
  agents: Iterable<AgentRoutingIdentityEntry>,
): ReadonlyMap<string, string> {
  const routingIdsByIdentityKey = new Map<string, string>();
  for (const agent of agents) {
    const pluginId = agent.identity?.pluginId ?? agent.pluginId;
    if (!pluginId) continue;
    routingIdsByIdentityKey.set(buildQualifiedPluginContributionKey({
      pluginId,
      localId: agent.identity?.localId ?? agent.id,
    }), agent.id);
  }
  return routingIdsByIdentityKey;
}

/** Read the routing id the supplied catalog assigned to this exact durable identity. */
export function readAgentRoutingIdForContributionIdentity(
  routingIdsByIdentityKey: ReadonlyMap<string, string>,
  identity: PluginContributionIdentityV1,
): string | null {
  return routingIdsByIdentityKey.get(buildQualifiedPluginContributionKey(identity)) ?? null;
}

/**
 * Resolve either a catalog routing id or an exact qualified contribution address.
 * The supplied catalog owns routing: bundled ids can remain bare, installed ids
 * remain qualified, and another plugin's coincident local id never becomes an alias.
 */
export function resolveAgentRoutingId(
  agentId: string,
  agents: Iterable<AgentRoutingIdentityEntry>,
): string | null {
  const entries = [...agents];
  const exact = entries.find(entry => entry.id === agentId);
  if (exact) return exact.id;
  const identity = parseQualifiedPluginContributionKey(agentId);
  return identity
    ? readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(entries), identity)
    : null;
}
