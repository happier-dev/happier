import { compareSessionFolderWorkspaceRefs } from '@/sync/domains/session/folders';

import type { SessionListTreeContainerMetadata, SessionListTreeRowMetadata } from './sessionListTreeTypes';

export function canMoveSessionListSourceToContainer(
    source: SessionListTreeRowMetadata,
    container: SessionListTreeContainerMetadata,
): boolean {
    if (source.kind === 'workspace-root') {
        return container.kind === 'workspace-order' && container.containerId === source.containerId;
    }
    if (container.kind !== 'children' || container.rootId !== source.rootId) return false;
    // The presentation root may cover several checkouts. Clearing a folder
    // assignment keeps the source's own checkout; a folder destination does not.
    return container.folderId == null
        || !source.workspace
        || !container.workspace
        || compareSessionFolderWorkspaceRefs(source.workspace, container.workspace);
}

export function canReorderSessionListSourceAroundTarget(
    source: SessionListTreeRowMetadata,
    target: SessionListTreeRowMetadata,
): boolean {
    if (source.kind === 'workspace-root') {
        return target.kind === 'workspace-root' && target.containerId === source.containerId;
    }
    if (target.kind === 'workspace-root' || target.rootId !== source.rootId) return false;
    if (source.item.type === 'session' && target.item.type === 'session'
        && source.item.groupKind === 'pinned' && target.item.groupKind === 'pinned') return true;
    return !source.workspace || !target.workspace
        || compareSessionFolderWorkspaceRefs(source.workspace, target.workspace);
}
