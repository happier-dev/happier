import type { ProviderBrokerSourceApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { DaemonProviderModelProjectionRowV1 } from '@happier-dev/protocol/rpc/providers';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import type { ProviderModelDescriptorV1, ProviderWireProtocol } from '@happier-dev/protocol';

/** Content identity is shared by Agent and source projections. Observation
 * times describe freshness, not a change to the source's usable model facts. */
export function createProviderSourceCatalogRevision(input: Readonly<{
  connectionSecurityFingerprint: string;
  endpointSetFingerprint: string;
  activationOccurrenceId: string;
  rows: readonly Readonly<{
    descriptor: ProviderModelDescriptorV1;
    catalog: Readonly<{ stale: boolean }>;
    compatibilityFingerprint: string | null;
    selectedProtocol: ProviderWireProtocol | null;
  }>[];
}>): string {
  return computeCanonicalDomainSeparatedDigest('happier.team-credential-provider-model-catalog.v1', [
    input.connectionSecurityFingerprint, input.endpointSetFingerprint,
    input.activationOccurrenceId,
    JSON.stringify(input.rows.map(row => ({ descriptor: row.descriptor,
      catalog: { stale: row.catalog.stale },
      compatibilityFingerprint: row.compatibilityFingerprint, selectedProtocol: row.selectedProtocol }))),
  ]);
}

/** Source membership precedes any Agent compatibility or recipient selection. */
export type ProviderSourceModelCatalog = Readonly<{
  application: ProviderBrokerSourceApplicationBindingV1;
  sourceRevision: string;
  rows: readonly (Omit<DaemonProviderModelProjectionRowV1, 'ref' | 'application' | 'nativeSource'> & Readonly<{
    application: ProviderBrokerSourceApplicationBindingV1;
  }>)[];
}>;

export type ProviderSourceModelCatalogRequest = Readonly<{
  machineId: string;
  source: TeamCredentialSourceBindingV1;
  application?: ProviderBrokerSourceApplicationBindingV1;
  refreshPolicy?: 'current_only';
  forceRefresh?: true;
}>;

export type ProviderSourceModelCatalogResult = Readonly<
  | { status: 'success'; catalogs: readonly ProviderSourceModelCatalog[] }
  | { status: 'error'; error: ProviderErrorV1 }
>;

/** Shared membership rule for Provider and native Agent catalog publication. */
export function isProviderSourceModelCatalogConfidenceUsable(confidence: DaemonProviderModelProjectionRowV1['confidence'] | undefined): boolean {
  return confidence !== 'account_unverified';
}

/** Source execution consumes current membership; unverified and stale rows are diagnostic only. */
export function projectCurrentProviderSourceModelCatalogs(catalogs: readonly ProviderSourceModelCatalog[]): ProviderSourceModelCatalogResult {
  return { status: 'success', catalogs: catalogs.flatMap(catalog => {
    const rows = catalog.rows.filter(row => isProviderSourceModelCatalogConfidenceUsable(row.confidence)
      && !row.catalog.stale && row.visibility === 'visible'
      && row.compatibility.result.status !== 'incompatible');
    return rows.length > 0 ? [{ ...catalog, rows }] : [];
  }) };
}
