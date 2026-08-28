import type {
    SessionExecutionTargetV1,
    SessionOrganizationPlacementV1,
} from '@happier-dev/protocol';
import {
    compareSessionFolderWorkspaceRefs,
    normalizeSessionFolderWorkspaceRef,
    type SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';

export type NewSessionOrganizationFolderTarget = Readonly<{
    folderId: string;
    workspace: SessionFolderWorkspaceRefV1 | null;
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
}>): boolean {
    return params.featureEnabled
        || (params.placement.folderId === null && params.placement.tagIds.length === 0);
}

export function reconcileNewSessionOrganizationPlacementForWorkspace(params: Readonly<{
    placement: SessionOrganizationPlacementV1;
    executionTarget: SessionExecutionTargetV1 | null;
    directory: string;
    folders: readonly NewSessionOrganizationFolderTarget[];
}>): SessionOrganizationPlacementV1 {
    if (!params.placement.folderId) return params.placement;
    const folder = params.folders.find((candidate) => candidate.folderId === params.placement.folderId);
    const requestedWorkspace = params.executionTarget
        ? normalizeSessionFolderWorkspaceRef({
            t: 'workspaceScope',
            serverId: params.executionTarget.serverId,
            machineId: params.executionTarget.machineId,
            rootPath: params.directory,
        })
        : null;
    const compatible = Boolean(folder?.workspace && requestedWorkspace
        && compareSessionFolderWorkspaceRefs(folder.workspace, requestedWorkspace));
    return compatible ? params.placement : { ...params.placement, folderId: null };
}
