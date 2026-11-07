import { MarketplaceIndexSourceSnapshotV1Schema, type MarketplaceIndexEntryV1, type MarketplaceIndexSourceSnapshotV1 } from '../../marketplace/marketplaceIndexV1.js';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '../../marketplace/marketplaceSourceRegistryV1.js';
import type { RegistryKindV1, RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryItemSummaryV1, RegistryItemV1, RegistryPluginListingSummaryV1 } from '../registryItemsV1.js';

/** Agent browsing selects plugin listings; their identity and install handoff stay plugin-owned. */
export function registryPluginSupportsKindV1(listing: MarketplaceIndexEntryV1, kind: RegistryKindV1): boolean {
  return kind === 'plugin' || kind === 'agent' && listing.summary.contributions.includes('agents');
}

export function registryMarketplaceSourceV1(source: RegistrySourceV1): MarketplaceIndexSourceSnapshotV1['source'] {
  return MarketplaceIndexSourceSnapshotV1Schema.shape.source.parse({
    id: source.id, title: source.title, sourceUrl: source.url,
    kind: source.format === 'happier-npm' ? 'community-npm'
      : source.url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL ? 'curated' : 'user',
  });
}

export function registryPluginListingSummaryV1(listing: MarketplaceIndexEntryV1): RegistryPluginListingSummaryV1 {
  return { pluginId: listing.pluginId, packageName: listing.distribution.packageName,
    publisher: listing.publisher, categories: listing.categories, contributions: listing.summary.contributions,
    executableRealms: listing.summary.executableRealms, platforms: listing.compatibility.platforms,
    review: listing.review, updatePolicy: listing.updatePolicy, links: listing.links };
}

export function registryPluginSummaryV1(source: RegistrySourceV1, listing: MarketplaceIndexEntryV1): RegistryItemSummaryV1 {
  return { sourceId: source.id, kind: 'plugin', itemId: source.format === 'happier-npm' ? listing.distribution.packageName : listing.pluginId,
    title: listing.display.title, ...(listing.display.description === null ? {} : { description: listing.display.description }),
    version: listing.distribution.version, publisher: { name: listing.publisher.displayName },
    pluginListing: registryPluginListingSummaryV1(listing),
    ...(listing.links.repository || listing.links.homepage ? { links: {
      ...(listing.links.repository ? { repository: listing.links.repository } : {}),
      ...(listing.links.homepage ? { website: listing.links.homepage } : {}),
    } } : {}),
    ...(source.url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL ? { flags: { pick: true } } : {}),
  };
}

export function registryPluginItemV1(source: RegistrySourceV1, listing: MarketplaceIndexEntryV1, fetchedAt: number): RegistryItemV1 {
  return { summary: registryPluginSummaryV1(source, listing),
    payload: { kind: 'plugin', listing, source: registryMarketplaceSourceV1(source) }, fetchedAt };
}
