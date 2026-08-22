import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

import type { ProviderContributionRegistryView } from './types';

export function resolveProviderContributionRegistryView(
  registry: Pick<ResolvedContributionRegistry, 'providersByContributionKey'>,
): ProviderContributionRegistryView {
  if (!registry.providersByContributionKey) {
    throw new Error('Resolved contribution registry is missing its provider contribution index');
  }
  return { providersByContributionKey: registry.providersByContributionKey };
}
