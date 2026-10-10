import type { ProviderContributionV1 } from '../contributions/v1.js';
import { isBundledProviderCatalogParserV1 } from '../catalog/descriptorV1.js';
import { createProviderErrorV1 } from '../errors.js';
import { CustomProviderTemplateV1Schema, type CustomProviderTemplateV1 } from './customTemplateV1.js';
import type { ProviderConnectionV1 } from './v1.js';

/** A Custom copy retains only effects the host can implement without its plugin. */
export function createProviderCustomCopyTemplateV1(input: Readonly<{
  connection: ProviderConnectionV1;
  definition: ProviderContributionV1 | CustomProviderTemplateV1;
  displayName: string;
  machineId?: string;
}>): CustomProviderTemplateV1 {
  const context = { connectionId: input.connection.id, ...(input.machineId ? { machineId: input.machineId } : {}) };
  if (input.connection.source.kind === 'custom') {
    return CustomProviderTemplateV1Schema.parse({ ...input.connection.source.template, name: input.displayName });
  }
  const definition = input.definition;
  const transports = (definition.credential?.transports ?? []).flatMap(transport => {
    if (transport.destination.kind !== 'httpHeader'
      || (transport.destination.format !== 'raw' && transport.destination.format !== 'bearer')) return [];
    const uses = transport.uses.filter((use): use is 'probe' | 'runtime' => use === 'probe' || use === 'runtime');
    return uses.length ? [{ ...transport, uses, destination: transport.destination }] : [];
  });
  if (definition.credential && !transports.length) throw createProviderErrorV1('provider_credential_transport_unavailable', context);
  const overrides = new Map((input.connection.endpointOverrides ?? []).map(value => [value.endpointTemplateId, value.baseUrl]));
  const endpointTemplates = definition.endpointTemplates.map(endpoint => {
    const baseUrl = overrides.get(endpoint.id) ?? endpoint.baseUrl
      ?? ('localUrlCandidates' in endpoint && endpoint.localUrlCandidates?.length === 1 ? endpoint.localUrlCandidates[0] : null);
    if (!baseUrl) throw createProviderErrorV1('provider_connection_invalid', context);
    return { id: endpoint.id, protocol: endpoint.protocol, baseUrl,
      ...(endpoint.publicHeaders ? { publicHeaders: endpoint.publicHeaders } : {}),
      capabilities: { streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const,
        statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const } };
  });
  const probes = 'probes' in definition.catalog ? definition.catalog.probes : [];
  if (probes.some(probe => !isBundledProviderCatalogParserV1(probe.parser))) {
    throw createProviderErrorV1('provider_connection_invalid', context);
  }
  return CustomProviderTemplateV1Schema.parse({ v: 1, name: input.displayName, endpointTemplates,
    ...(definition.credential ? { credential: { ...definition.credential, transports } } : {}),
    catalog: probes.length ? { source: 'probe', manualModelPolicy: definition.catalog.manualModelPolicy, probes }
      : { source: 'manual', manualModelPolicy: 'allowed' } });
}
