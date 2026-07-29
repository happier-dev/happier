import {
  ProviderBoundModelRefSchema,
  resolveProviderCatalogReferenceV1,
} from '@happier-dev/protocol';

import type {
  ProviderCatalogModelReferenceResolution,
  ProviderConnectionCatalog,
} from './types';

export function resolveProviderCatalogModelRef(input: Readonly<{
  catalog: ProviderConnectionCatalog;
  ref: unknown;
  agentSupportsFreeformModelIds: boolean;
  displaySnapshot?: Readonly<{ name: string }>;
}>): ProviderCatalogModelReferenceResolution {
  const ref = ProviderBoundModelRefSchema.parse(input.ref);
  if (ref.providerConnectionId === null) {
    throw new TypeError('A provider connection catalog cannot resolve a native model ref');
  }
  if (ref.agentTargetKey !== input.catalog.agentTargetKey
    || ref.providerConnectionId !== input.catalog.connectionId) {
    throw new TypeError('Provider model ref does not belong to this catalog');
  }
  const activeRows = input.catalog.rows.map((row) => ({
    descriptor: row.descriptor,
    sources: row.sources,
    confidence: row.confidence,
    catalogStale: row.presentation.catalog.stale,
  }));
  const staleRows = input.catalog.staleRows.map((row) => ({
    descriptor: row.descriptor,
    sources: row.sources,
    confidence: row.confidence,
    catalogStale: true,
    stale: true as const,
  }));
  const resolution = resolveProviderCatalogReferenceV1({
    modelId: ref.modelId,
    activeRows,
    staleRows,
    manualModelPolicy: input.catalog.manualModelPolicy,
    agentSupportsFreeformModelIds: input.agentSupportsFreeformModelIds,
    ...(input.displaySnapshot ? { displaySnapshot: input.displaySnapshot } : {}),
  });
  if (resolution.status === 'listed') {
    const row = input.catalog.rows.find((candidate) => candidate.ref.modelId === ref.modelId);
    if (!row) throw new TypeError('Protocol catalog resolution returned an unknown active row');
    return { status: 'listed', ref, row };
  }
  if (resolution.status === 'not_currently_listed') {
    return {
      status: resolution.status,
      ref,
      descriptor: resolution.descriptor,
      provenance: resolution.provenance,
    };
  }
  return { status: 'not_found', ref, errorCode: resolution.errorCode };
}
