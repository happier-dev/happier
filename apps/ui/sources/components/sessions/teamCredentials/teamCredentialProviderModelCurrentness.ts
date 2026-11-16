import type {
    TeamCredentialProviderModelSelectionV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';

export { findAssignedProviderModelCredentialBinding, type AssignedProviderModelCredentialBinding } from '@/sync/domains/teams/teamCredentialProviderModelSelection';

type TeamCredentialProviderModel = TeamCredentialResourceCatalogEntryV1['providerModels'][number];

/** Exact route-bearing model currentness inside one already-current resource. */
export function findCurrentTeamCredentialProviderModel(
    resource: TeamCredentialResourceCatalogEntryV1,
    selection: TeamCredentialProviderModelSelectionV1,
): TeamCredentialProviderModel | null {
    if (resource.id !== selection.resourceId
        || resource.teamId !== selection.teamId
        || resource.resourceRevision !== selection.expectedResourceRevision) return null;
    return resource.providerModels.find((candidate) => (
            candidate.selection.resourceId === selection.resourceId
            && candidate.selection.teamId === selection.teamId
            && candidate.selection.expectedResourceRevision === selection.expectedResourceRevision
            && candidate.selection.deliveryMode === selection.deliveryMode
            && candidate.selection.agentTargetKey === selection.agentTargetKey
            && candidate.selection.modelId === selection.modelId
        )) ?? null;
}

export function resourceHasAvailableTeamCredentialProviderModel(
    resource: TeamCredentialResourceCatalogEntryV1,
    selection: TeamCredentialProviderModelSelectionV1,
): boolean {
    return readTeamCredentialDeliveryReadinessV1(resource.readiness, selection.deliveryMode).kind === 'available'
        && findCurrentTeamCredentialProviderModel(resource, selection)?.availability === 'available';
}
