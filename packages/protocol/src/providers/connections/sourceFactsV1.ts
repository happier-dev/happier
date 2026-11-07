import type { ProviderContributionV1, ProviderEndpointTemplateV1, ProviderModelLoadDescriptorV1 } from '../contributions/v1.js';
import type { ProviderCredentialTransportV1 } from '../credentials/v1.js';
import type { ProviderCatalogProbeV1 } from '../catalog/descriptorV1.js';
import type { ProviderCatalogCommandFallbackV1 } from '../detection/descriptorV1.js';
import type { CustomProviderTemplateV1 } from './customTemplateV1.js';
import type { ProviderConnectionV1 } from './v1.js';
import type { AccountProviderDeclarationV1 } from '../catalog/accountModelProjectionV1.js';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '../../rpc/providers.js';
import { normalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import type { PluginLocalizedStringV2 } from '../../plugins/contributions/publicTypes.js';
import { providerEndpointPolicySecurityFactsV1 } from '../endpointPolicyV1.js';

/** Only declared credential slots can acquire Saved Secret authority. Clearing stale bindings is independent. */
export function isProviderConnectionCredentialSlotDeclaredV1(
  definition: ProviderContributionV1 | CustomProviderTemplateV1,
  slotId: string,
): boolean {
  return definition.credential?.slotId === slotId
    || readProviderAdditionalCredentialSlotsV1(definition.credential).some(credential => credential.slotId === slotId)
    || 'kind' in definition && (definition.usageSources ?? []).some(source => source.billingCredential?.slotId === slotId);
}

/** Presentation of the existing declared custody slots, shared by every editor/read. */
export function readProviderAdditionalCredentialSlotsV1(credential: ProviderContributionV1['credential'] | CustomProviderTemplateV1['credential']) {
  const slots = new Map<string, { slotId: string; required: true; label?: PluginLocalizedStringV2 }>();
  for (const transport of credential?.transports ?? []) {
    for (const { slotId, label } of transport.additionalCredentials ?? []) {
      if (!slots.has(slotId)) slots.set(slotId, { slotId, required: true, ...(label === undefined ? {} : { label }) });
    }
  }
  return [...slots.values()];
}

/** The unconfigured declaration list is the same Account and machine authoring projection. */
export function projectAvailableProviderContributionsV1(input: Readonly<{
  connections: readonly ProviderConnectionV1[];
  definitions: readonly AccountProviderDeclarationV1[];
}>): Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>['available'] {
  const configured = new Set(input.connections.flatMap(connection => connection.source.kind === 'contribution'
    ? [normalizeProviderContributionKeyV1(connection.source.contributionKey)] : []).filter((key): key is string => key !== null));
  return input.definitions.filter(({ contributionKey }) => !configured.has(contributionKey))
    .map(({ contributionKey, definition, provenance }) => ({
      contributionKey, name: definition.name, kind: definition.kind, provenance,
      icon: definition.icon ?? null,
      ...(definition.websiteUrl ? { websiteUrl: definition.websiteUrl } : {}),
      endpointTemplates: definition.endpointTemplates.map(endpoint => ({ id: endpoint.id, protocol: endpoint.protocol,
        ...providerEndpointPolicySecurityFactsV1(endpoint),
        ...(endpoint.publicHeaders ? { publicHeaders: endpoint.publicHeaders } : {}),
        ...(endpoint.publicHeaderHints ? { publicHeaderHints: endpoint.publicHeaderHints } : {}) })),
      credential: definition.credential ? {
        required: definition.credential.required,
        ...(definition.credential.keyUrl ? { keyUrl: definition.credential.keyUrl } : {}),
        ...(definition.credential.authorityDescription ? { authorityDescription: definition.credential.authorityDescription } : {}),
      } : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.contributionKey.localeCompare(right.contributionKey));
}

export type ProviderConnectionSourceFactsV1 = Readonly<{
  endpointTemplates: readonly ProviderEndpointTemplateV1[];
  credentialTransports: readonly ProviderCredentialTransportV1[];
  catalogProbes: readonly ProviderCatalogProbeV1[];
  availabilityProbe?: NonNullable<ProviderContributionV1['discovery']>['availabilityProbe'];
  catalogFallback?: ProviderCatalogCommandFallbackV1;
  modelLoad?: ProviderModelLoadDescriptorV1;
  inlineCompletion?: ProviderContributionV1['inlineCompletion'];
  usageSources?: ProviderContributionV1['usageSources'];
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
    ...(contribution?.inlineCompletion ? { inlineCompletion: contribution.inlineCompletion } : {}),
    ...(contribution?.usageSources ? { usageSources: contribution.usageSources } : {}),
  };
}
