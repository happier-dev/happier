import {
  normalizeProviderContributionKeyV1,
} from '@happier-dev/protocol';

import type { ProviderContributionRegistryView } from './types';

export function normalizeProviderContributionRegistryKey(
  contributionKeyInput: string,
): string | null {
  return normalizeProviderContributionKeyV1(contributionKeyInput);
}

export function resolveProviderContributionRegistryEntry(
  registry: ProviderContributionRegistryView,
  contributionKeyInput: string,
) {
  const contributionKey = normalizeProviderContributionRegistryKey(contributionKeyInput);
  if (!contributionKey) return null;
  const contribution = registry.providersByContributionKey.get(contributionKey);
  return contribution ? { contributionKey, contribution } as const : null;
}

export function getProviderContribution(
  registry: ProviderContributionRegistryView,
  contributionKeyInput: string,
) {
  return resolveProviderContributionRegistryEntry(registry, contributionKeyInput)?.contribution ?? null;
}
