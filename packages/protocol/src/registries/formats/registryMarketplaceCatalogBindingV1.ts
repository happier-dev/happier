import type { MarketplaceIndexSourceSnapshotV1 } from '../../marketplace/marketplaceIndexV1.js';
import { deriveMarketplaceSourceId } from '../../marketplace/marketplaceSourceRegistryV1.js';
import { parseQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import { RegistrySourceDescriptorV1Schema, type RegistrySourceV1 } from '../registrySourcesV1.js';
import { registryMarketplaceSourceV1 } from './registryPluginListingV1.js';

/** Prove configured custody before using even a previously admitted cached catalog. */
export function assertRegistryMarketplaceCatalogSourceV1(source: RegistrySourceV1): void {
  if (source.format !== 'happier-catalog') {
    throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  }
  if (source.id === deriveMarketplaceSourceId(source.url)) return;
  const descriptor = RegistrySourceDescriptorV1Schema.safeParse(source);
  const identity = parseQualifiedPluginContributionKey(source.id);
  if (!descriptor.success || descriptor.data.origin.kind !== 'plugin' || !identity
    || identity.pluginId !== descriptor.data.origin.pluginId || identity.localId !== descriptor.data.origin.localId) {
    throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  }
}

/** Admit the published document before binding an installed declaration's registry identity. */
export function bindRegistryMarketplaceCatalogV1(
  catalog: MarketplaceIndexSourceSnapshotV1,
  source: RegistrySourceV1,
): MarketplaceIndexSourceSnapshotV1 {
  const expected = registryMarketplaceSourceV1(source);
  if (source.format !== 'happier-catalog' || catalog.source.id !== deriveMarketplaceSourceId(source.url)
    || catalog.source.sourceUrl !== expected.sourceUrl || catalog.source.kind !== expected.kind) {
    throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  }
  assertRegistryMarketplaceCatalogSourceV1(source);
  if (catalog.source.id === source.id) return catalog;
  return {
    ...catalog,
    source: { ...catalog.source, id: source.id },
    ...(catalog.discovery ? {
      discovery: {
        ...catalog.discovery,
        items: catalog.discovery.items.map(item => item.reference.type === 'registryItem'
          && item.reference.sourceId === catalog.source.id
          ? { ...item, reference: { ...item.reference, sourceId: source.id } }
          : item),
      },
    } : {}),
  };
}
