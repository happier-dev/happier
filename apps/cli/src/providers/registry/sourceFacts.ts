import { ProviderEndpointTemplateV1Schema } from '@happier-dev/protocol/providers/contributions';

import type { ResolvedProviderConnectionRecord } from './types';

export type ResolvedProviderSourceFacts = Readonly<{
  endpointTemplates: readonly ReturnType<typeof ProviderEndpointTemplateV1Schema.parse>[];
  credential:
    | NonNullable<Extract<ResolvedProviderConnectionRecord['source'], { kind: 'contribution' }>['definition']['credential']>
    | NonNullable<Extract<ResolvedProviderConnectionRecord['source'], { kind: 'custom' }>['template']['credential']>
    | undefined;
  catalog: Extract<ResolvedProviderConnectionRecord['source'], { kind: 'contribution' }>['definition']['catalog']
    | Extract<ResolvedProviderConnectionRecord['source'], { kind: 'custom' }>['template']['catalog'];
  compatibilityOverrides: Extract<ResolvedProviderConnectionRecord['source'], { kind: 'contribution' }>['definition']['compatibilityOverrides'];
  contributionKey: string | null;
}>;

/** Resolve the management destination shared by catalog presentation and load admission. */
export function resolveProviderModelLoadTarget(record: ResolvedProviderConnectionRecord) {
  const source = record.source;
  if (record.deployment.kind !== 'external' || source.kind !== 'contribution'
    || source.definition.kind !== 'local' || !source.definition.modelLoad) return null;

  const { credential, modelLoad: descriptor } = source.definition;
  const endpoint = record.endpoints.find(candidate => candidate.endpointTemplateId === descriptor.endpointTemplateId);
  if (!endpoint) return { status: 'endpoint_unavailable' as const };

  const transports = credential?.transports.filter(transport =>
    transport.protocols.includes(endpoint.protocol) && transport.uses.includes('management')) ?? [];
  if (credential && transports.length !== 1) return { status: 'credential_transport_unavailable' as const };

  return { status: 'available' as const, descriptor, endpoint, credential, selectedTransport: transports[0] ?? null };
}

export function projectProviderModelLoadCapability(record: ResolvedProviderConnectionRecord, enabled: boolean) {
  const target = resolveProviderModelLoadTarget(record);
  if (target?.status !== 'available') return { action: 'descriptor_absent' as const, preflightPolicy: null };
  return { action: enabled ? 'available' as const : 'feature_disabled' as const,
    preflightPolicy: target.descriptor.preflightPolicy };
}

/** Bound family declarations supply cold model facts until the Gateway observes membership. */
export function resolveProviderSourceCatalog(record: ResolvedProviderConnectionRecord): ResolvedProviderSourceFacts['catalog'] {
  const catalog = record.source.kind === 'contribution' ? record.source.definition.catalog : record.source.template.catalog;
  if (record.deployment.kind !== 'managedLocal') return catalog;
  const purposes = new Set(record.deployment.purposeBindingIntents.bindings.map(binding => binding.purpose.purpose));
  const familyModels = record.deployment.managedRuntime.connectedAccounts
    .filter(family => purposes.has(family.purpose))
    .flatMap(family => family.staticModels ?? []);
  if (familyModels.length === 0) return catalog;
  const staticModels = [...new Map([
    ...familyModels, ...('staticModels' in catalog ? catalog.staticModels : []),
  ].map(model => [model.id, model])).values()];
  return 'probes' in catalog
    ? { ...catalog, source: 'static+probe', staticModels,
        membershipPolicy: catalog.source === 'probe' ? 'probe-authoritative' : catalog.membershipPolicy }
    : { ...catalog, source: 'static', staticModels };
}

/** One normalized, non-secret source-fact projection shared by spawn and catalog compatibility. */
export function resolveProviderSourceFacts(record: ResolvedProviderConnectionRecord): ResolvedProviderSourceFacts {
  const source = record.source;
  const rawEndpoints = source.kind === 'contribution'
    ? source.definition.endpointTemplates
    : source.template.endpointTemplates;
  const credential = source.kind === 'contribution'
    ? source.definition.credential
    : source.template.credential;
  if (record.deployment.kind === 'managedLocal') {
    return {
      endpointTemplates: rawEndpoints.map((template) =>
        ProviderEndpointTemplateV1Schema.parse(template)),
      credential: credential && source.kind === 'contribution'
        && source.definition.managedRuntime?.credentialRequired === true
        ? { ...credential, required: true }
        : credential,
      catalog: resolveProviderSourceCatalog(record),
      compatibilityOverrides: source.kind === 'contribution'
        ? source.definition.compatibilityOverrides
        : undefined,
      contributionKey: source.kind === 'contribution' ? source.contributionKey : null,
    };
  }
  const endpointTemplates = rawEndpoints.flatMap((template) => {
    const endpoint = record.endpoints.find((candidate) => candidate.endpointTemplateId === template.id);
    if (!endpoint) return [];
    return [ProviderEndpointTemplateV1Schema.parse({
      ...template,
      baseUrl: endpoint.normalizedUrl,
      requiresEndpointOverride: undefined,
      localUrlCandidates: undefined,
      publicHeaders: endpoint.publicHeaders,
    })];
  });
  return {
    endpointTemplates,
    credential,
    catalog: resolveProviderSourceCatalog(record),
    compatibilityOverrides: source.kind === 'contribution' ? source.definition.compatibilityOverrides : undefined,
    contributionKey: source.kind === 'contribution' ? source.contributionKey : null,
  };
}
