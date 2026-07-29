import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

type AgentActivationRegistry = Pick<
  ResolvedExecutablePluginRuntimeRegistry,
  'contributes' | 'activateContributionsOnDemand'
>;
type AgentActivationDemandResults = Awaited<
  ReturnType<AgentActivationRegistry['activateContributionsOnDemand']>
>;

export function resolveAgentRuntimeActivationDemand(
  registry: AgentActivationRegistry,
  agentId: string,
): Readonly<{ pluginId: string; family: 'agents'; localId: string }> | null {
  const contribution = registry.contributes.agentDefinitionsById.get(agentId);
  if (!contribution?.pluginId || !contribution.identity) return null;
  if (contribution.identity.pluginId !== contribution.pluginId) return null;
  return Object.freeze({
    pluginId: contribution.pluginId,
    family: 'agents',
    localId: contribution.identity.localId,
  });
}

export async function activateAgentRuntimeContributionOnDemand(
  registry: AgentActivationRegistry,
  agentId: string,
): Promise<AgentActivationDemandResults> {
  const demand = resolveAgentRuntimeActivationDemand(registry, agentId);
  if (!demand) return Object.freeze([]);
  return await registry.activateContributionsOnDemand([demand]);
}

export async function activateAllAgentRuntimeContributionsOnDemand(
  registry: AgentActivationRegistry,
): Promise<AgentActivationDemandResults> {
  const demands = [...registry.contributes.agentDefinitionsById.keys()]
    .sort()
    .flatMap((agentId) => {
      const demand = resolveAgentRuntimeActivationDemand(registry, agentId);
      return demand ? [demand] : [];
    });
  return await registry.activateContributionsOnDemand(demands);
}
