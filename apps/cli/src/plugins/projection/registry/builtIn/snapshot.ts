import type { AgentCatalogEntry, CatalogAgentId } from '@/agent/catalog/types';
import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../resolveBuiltInContributions';
import type { ResolvedContributionRegistry } from '../types';

/**
 * The sole immutable built-in snapshot. Import this owner only when the full
 * snapshot is needed; exact selections use the canonical projection directly.
 * Semantic admission settles before synchronous readers can see the snapshot.
 * Installed plugins and reloads never replace this built-in authority.
 */
let builtInResolvedContributionRegistry: ResolvedContributionRegistry | null = null;

export function getResolvedContributionRegistry(): ResolvedContributionRegistry {
  builtInResolvedContributionRegistry ??= Object.freeze(
    createResolvedContributionRegistry(resolveBuiltInContributions()),
  );
  return builtInResolvedContributionRegistry;
}

export function getBuiltInCatalogEntries(): Record<CatalogAgentId, AgentCatalogEntry> {
  return getResolvedContributionRegistry().catalogEntriesById as Record<CatalogAgentId, AgentCatalogEntry>;
}
