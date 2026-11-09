import type {
    SessionTeamCredentialBindingIntentListV1,
    SessionTeamCredentialBindingIntentV1,
    TeamCredentialProviderModelSelectionV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { readTeamCredentialDeliveryReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';

export type AssignedProviderModelCredentialBinding = Extract<
    SessionTeamCredentialBindingIntentV1,
    Readonly<{ resourceId: string }>
> & Readonly<{ slot: Readonly<{ kind: 'provider_model' }> }>;

type TeamCredentialProviderModel = TeamCredentialResourceCatalogEntryV1['providerModels'][number];

/** Read the one assigned Provider-model intent without reinterpreting a clear/null intent. */
export function findAssignedProviderModelCredentialBinding(
    bindings: SessionTeamCredentialBindingIntentListV1 | null | undefined,
): AssignedProviderModelCredentialBinding | null {
    return bindings?.find((binding): binding is AssignedProviderModelCredentialBinding => (
        binding.slot.kind === 'provider_model' && binding.resourceId !== null
    )) ?? null;
}

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
