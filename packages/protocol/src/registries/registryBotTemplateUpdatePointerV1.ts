import type { MarketplaceIndexEntryV1 } from '../marketplace/marketplaceIndexV1.js';
import type { RegistryItemPointerV1 } from './registryContentRefV1.js';

/** Select the existing registry offer without acquiring the template release. */
export function selectRegistryBotTemplateUpdatePointerV1(
  pointer: RegistryItemPointerV1,
  listing: MarketplaceIndexEntryV1,
): RegistryItemPointerV1 {
  return listing.updatePolicy === 'pinned' ? pointer : { ...pointer, version: listing.distribution.version };
}
