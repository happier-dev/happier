import { ProviderEndpointTemplateV1Schema } from '@happier-dev/protocol';

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

/** One normalized, non-secret source-fact projection shared by spawn and catalog compatibility. */
export function resolveProviderSourceFacts(record: ResolvedProviderConnectionRecord): ResolvedProviderSourceFacts {
  const source = record.source;
  const rawEndpoints = source.kind === 'contribution'
    ? source.definition.endpointTemplates
    : source.template.endpointTemplates;
  if (record.deployment.kind === 'managedLocal') {
    return {
      endpointTemplates: rawEndpoints.map((template) =>
        ProviderEndpointTemplateV1Schema.parse(template)),
      credential: source.kind === 'contribution'
        ? source.definition.credential
        : source.template.credential,
      catalog: source.kind === 'contribution'
        ? source.definition.catalog
        : source.template.catalog,
      compatibilityOverrides: source.kind === 'contribution'
        ? source.definition.compatibilityOverrides
        : undefined,
      contributionKey: source.kind === 'contribution' ? source.contributionKey : null,
    };
  }
  const endpointTemplates = rawEndpoints.map((template) => {
    const endpoint = record.endpoints.find((candidate) => candidate.endpointTemplateId === template.id);
    if (!endpoint) throw new TypeError('Resolved provider endpoint is missing its source template');
    return ProviderEndpointTemplateV1Schema.parse({
      ...template,
      baseUrl: endpoint.normalizedUrl,
      localUrlCandidates: undefined,
    });
  });
  return {
    endpointTemplates,
    credential: source.kind === 'contribution' ? source.definition.credential : source.template.credential,
    catalog: source.kind === 'contribution' ? source.definition.catalog : source.template.catalog,
    compatibilityOverrides: source.kind === 'contribution' ? source.definition.compatibilityOverrides : undefined,
    contributionKey: source.kind === 'contribution' ? source.contributionKey : null,
  };
}
