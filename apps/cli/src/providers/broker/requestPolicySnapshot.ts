import type { ProviderBrokerRouteGrantPayloadV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import type { ProviderSourceModelCatalogRequest, ProviderSourceModelCatalogResult } from '@/providers/modelManagement/sourceCatalog';
import { resolveTeamCredentialBrokerSourceCatalog } from './resourceTestCandidate';
import { teamCredentialBrokerResourceAcceptsMachine } from './teamCredentialBrokerSourceOwner';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';

/** The custodian reads its own catalog; Home independently admits the recipient. */
export async function resolveTeamCredentialBrokerRequestPolicy(input: Readonly<{
  machineId: string;
  authority: ProviderBrokerRouteGrantPayloadV1;
  signal: AbortSignal;
  readResource(resourceId: string, signal: AbortSignal): Promise<TeamCredentialResourceSummaryV1 | null>;
  readSourceModelCatalogs(request: ProviderSourceModelCatalogRequest, signal?: AbortSignal): Promise<ProviderSourceModelCatalogResult>;
}>) {
  const resource = await input.readResource(input.authority.resourceId, input.signal);
  if (!teamCredentialBrokerResourceAcceptsMachine(resource, input.machineId) || resource.teamId !== input.authority.teamId) return null;
  const catalog = await resolveTeamCredentialBrokerSourceCatalog({
    machineId: input.machineId, teamId: resource.teamId, resourceId: resource.id,
    expectedResourceRevision: resource.revision, source: resource.source,
    application: input.authority.application, readSourceModelCatalogs: input.readSourceModelCatalogs, signal: input.signal,
  }).catch(preserveBrokerSourceHealthFailure);
  return catalog ? {
    resourceRevision: resource.revision, sourceRevision: catalog.sourceRevision,
    application: input.authority.application, policy: resource.requestPolicy, source: resource.source,
    modelCatalog: { models: catalog.rows.map(row => ({ id: row.descriptor.id,
      ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }) })),
      resolveCanonicalModelId: catalog.resolveCanonicalModelId },
  } : null;
}
