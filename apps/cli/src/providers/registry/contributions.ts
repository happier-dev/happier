import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { getAgentStaticModels } from '@happier-dev/agents';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol';

import type { ProviderContributionRegistryView } from './types';

export function resolveProviderContributionRegistryView(
  registry: Pick<ResolvedContributionRegistry, 'providersByContributionKey'> & Partial<Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>>,
  runtimeRegistryGeneration: number | undefined,
  readPluginOccurrenceId?: (pluginId: string) => string | null,
): ProviderContributionRegistryView {
  if (!registry.providersByContributionKey) {
    throw new Error('Resolved contribution registry is missing its provider contribution index');
  }
  const providerActivationOccurrenceIdsByPluginId = readPluginOccurrenceId
    ? new Map([...new Set(
        [...registry.providersByContributionKey.values()].map((provider) => provider.pluginId),
      )].flatMap((pluginId) => {
        const occurrenceId = readPluginOccurrenceId(pluginId);
        return occurrenceId ? [[pluginId, occurrenceId] as const] : [];
      }))
    : undefined;
  return {
    providersByContributionKey: registry.providersByContributionKey,
    ...(registry.agentDefinitionsById ? { agentDefinitionsById: registry.agentDefinitionsById } : {}),
    runtimeRegistryGeneration,
    ...(providerActivationOccurrenceIdsByPluginId
      ? { providerActivationOccurrenceIdsByPluginId }
      : {}),
  };
}

/** Borrow contributed display facts, never another source's membership or capabilities. */
export function readProviderModelNameCatalog(registry: ProviderContributionRegistryView): readonly ProviderModelDescriptorV1[] {
  return [
    ...[...registry.providersByContributionKey.values()].flatMap(({ definition }) =>
      'staticModels' in definition.catalog ? definition.catalog.staticModels : []),
    ...[...(registry.agentDefinitionsById?.values() ?? [])].flatMap(({ id }) =>
      getAgentStaticModels(id, { catalogOnly: true })),
  ];
}
