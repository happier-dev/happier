import type { SessionOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type NewSessionOrganizationFolderTarget = Readonly<{
    folderId: string;
    serverId: string;
}>;

export function normalizeNewSessionOrganizationPlacement(
    value: SessionOrganizationPlacementV1 | null | undefined,
): SessionOrganizationPlacementV1 {
    const folderId = value?.folderId?.trim() || null;
    const tagIds = [...new Set((value?.tagIds ?? []).map((tagId) => tagId.trim()).filter(Boolean))];
    return { folderId, tagIds };
}

export function isNewSessionOrganizationPlacementAvailable(params: Readonly<{
    featureEnabled: boolean;
    placement: SessionOrganizationPlacementV1;
    placementScope?: ServerAccountScope | null;
    targetScope?: ServerAccountScope | null;
    sectionAvailable?: boolean;
}>): boolean {
    if (params.placement.folderId === null && params.placement.tagIds.length === 0) return true;
    return params.featureEnabled && params.sectionAvailable !== false
        && (params.placementScope === undefined && params.targetScope === undefined
            || areServerAccountScopesEqual(params.placementScope, params.targetScope));
}

export function reconcileNewSessionOrganizationPlacementForAccount(params: Readonly<{
    placement: SessionOrganizationPlacementV1;
    targetServerId: string | null;
    folders: readonly NewSessionOrganizationFolderTarget[];
}>): SessionOrganizationPlacementV1 {
    if (!params.placement.folderId) return params.placement;
    const folder = params.folders.find((candidate) => candidate.folderId === params.placement.folderId);
    const compatible = Boolean(folder && params.targetServerId
        && folder.serverId === params.targetServerId);
    return compatible ? params.placement : { ...params.placement, folderId: null };
}
