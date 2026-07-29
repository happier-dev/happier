import {
  resolveProviderContributionRegistryEntry,
  type ProviderContributionRegistryView,
} from '@/providers/registry';
import type { ProviderConnectionView } from '@/providers/connections/service';
import { ProviderCliError } from './types';

export function resolveContributionIdentity(
  input: string,
  registry: ProviderContributionRegistryView,
): Readonly<{ contributionKey: string; contribution: ProviderContributionRegistryView['providersByContributionKey'] extends ReadonlyMap<string, infer T> ? T : never }> {
  const resolved = resolveProviderContributionRegistryEntry(registry, input);
  if (resolved) return resolved;
  const folded = input.trim().toLocaleLowerCase();
  const candidates = [...registry.providersByContributionKey.entries()].filter(([key, entry]) =>
    key.toLocaleLowerCase() === folded
    || entry.definition.id.toLocaleLowerCase() === folded
    || entry.definition.name.toLocaleLowerCase() === folded);
  if (candidates.length === 1) return { contributionKey: candidates[0]![0], contribution: candidates[0]![1] };
  if (candidates.length > 1) {
    throw new ProviderCliError('provider_contribution_ambiguous', `Provider '${input}' is ambiguous`, {
      candidates: candidates.map(([contributionKey, entry]) => ({ contributionKey, name: entry.definition.name })),
    });
  }
  throw new ProviderCliError('provider_contribution_not_found', `Provider contribution '${input}' was not found`);
}

export function resolveConnectionIdentity(input: string, connections: readonly ProviderConnectionView[]): ProviderConnectionView {
  const exact = connections.find((entry) => entry.connectionId === input);
  if (exact) return exact;
  const folded = input.trim().toLocaleLowerCase();
  const candidates = connections.filter((entry) => entry.displayName.toLocaleLowerCase() === folded);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new ProviderCliError('provider_connection_ambiguous', `Provider connection '${input}' is ambiguous`, {
      candidates: candidates.map((entry) => ({
        connectionId: entry.connectionId,
        displayName: entry.displayName,
        contributionKey: entry.contributionKey,
      })),
    });
  }
  throw new ProviderCliError('provider_connection_not_found', `Provider connection '${input}' was not found`);
}
