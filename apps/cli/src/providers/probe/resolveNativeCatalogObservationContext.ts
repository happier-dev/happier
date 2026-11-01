import type { AgentModelConfig } from '@happier-dev/agents';
import type {
  PluginContributionIdentityV1,
  ProviderContributionV1,
  QualifiedConnectedAccountPurposeV1,
  QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';
import type { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import type { AgentCatalogEntry } from '@/agent/catalog/types';

export type NativeCatalogObservationContext = Readonly<{
  consumer: PluginContributionIdentityV1;
  purpose: QualifiedConnectedAccountPurposeV1;
  requestAuthUse: QualifiedConnectedAccountRequestAuthUseV1;
  provider: ProviderContributionV1;
  catalogEntry: AgentCatalogEntry | null | undefined;
}>;

export function resolveNativeCatalogObservationContext(input: Readonly<{
  agentId: string;
  observation: NonNullable<AgentModelConfig['nativeCatalogObservation']>;
  registry: ReturnType<typeof getResolvedContributionRegistry>;
  catalogEntry?: AgentCatalogEntry | null;
}>): NativeCatalogObservationContext | null {
  const agent = input.registry.agentDefinitionsById.get(input.agentId);
  const consumer = agent?.identity;
  const provider = consumer
    ? input.registry.providersByContributionKey?.get(`${consumer.pluginId}/${input.observation.providerLocalId}`)
    : null;
  const catalogEntry = input.catalogEntry === undefined ? agent?.catalogEntry : input.catalogEntry;
  const declaredUse = catalogEntry?.connectedAccountRequestAuthUses?.find((candidate) => (
    candidate.purpose === input.observation.purpose
  ));
  if (!consumer || !provider || !declaredUse) return null;
  const purpose = Object.freeze({ consumer, purpose: input.observation.purpose });
  return Object.freeze({
    consumer,
    purpose,
    requestAuthUse: Object.freeze({
      purpose,
      materialization: declaredUse.materialization,
    }),
    provider: provider.definition,
    catalogEntry,
  });
}
