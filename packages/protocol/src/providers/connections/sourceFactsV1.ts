import type { ProviderContributionV1, ProviderEndpointTemplateV1, ProviderModelLoadDescriptorV1 } from '../contributions/v1.js';
import type { ProviderCredentialTransportV1 } from '../credentials/v1.js';
import type { ProviderCatalogProbeV1 } from '../catalog/descriptorV1.js';
import type { ProviderCatalogCommandFallbackV1 } from '../detection/descriptorV1.js';
import type { CustomProviderTemplateV1 } from './customTemplateV1.js';

export type ProviderConnectionSourceFactsV1 = Readonly<{
  endpointTemplates: readonly ProviderEndpointTemplateV1[];
  credentialTransports: readonly ProviderCredentialTransportV1[];
  catalogProbes: readonly ProviderCatalogProbeV1[];
  availabilityProbe?: NonNullable<ProviderContributionV1['discovery']>['availabilityProbe'];
  catalogFallback?: ProviderCatalogCommandFallbackV1;
  modelLoad?: ProviderModelLoadDescriptorV1;
}>;

/** Account grant authoring and machine admission fingerprint the same declared effects. */
export function readProviderConnectionSourceFactsV1(
  definition: ProviderContributionV1 | CustomProviderTemplateV1,
): ProviderConnectionSourceFactsV1 {
  const contribution = 'kind' in definition ? definition : null;
  return {
    endpointTemplates: definition.endpointTemplates,
    credentialTransports: definition.credential?.transports ?? [],
    catalogProbes: 'probes' in definition.catalog ? definition.catalog.probes : [],
    ...(contribution?.discovery ? { availabilityProbe: contribution.discovery.availabilityProbe } : {}),
    ...(contribution?.discovery?.catalogFallback ? { catalogFallback: contribution.discovery.catalogFallback } : {}),
    ...(contribution?.modelLoad ? { modelLoad: contribution.modelLoad } : {}),
  };
}
