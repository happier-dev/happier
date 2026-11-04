import { compareSessionFolderWorkspaceRefs } from '@/sync/domains/session/folders';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionListTreeContainerMetadata, SessionListTreeRowMetadata } from './sessionListTreeTypes';

export function readSessionListItemProjectKey(item: SessionListIndexItem): QualifiedProjectKeyV1 | null {
    if (!('projectKey' in item) || !item.projectKey || typeof item.projectKey !== 'object') return null;
    return 'projectKey' in item.projectKey && typeof item.projectKey.projectKey === 'string'
        ? item.projectKey : null;
}

/** Pin presentation does not take ownership of a Session's Section assignment. */
export function resolveSessionListDestinationFolderId(
    source: SessionListTreeRowMetadata,
    container: SessionListTreeContainerMetadata,
): string | null {
    return container.destinationKind === 'pinned' ? source.folderId : container.folderId;
}

/** Sections own membership within one Home; Project destinations never change execution identity. */
export function canMoveSessionListSourceToContainer(
    source: SessionListTreeRowMetadata,
    container: SessionListTreeContainerMetadata,
): boolean {
    if (source.kind === 'workspace-root') return container.kind === 'workspace-order' && container.containerId === source.containerId;
    if (container.kind !== 'children') return false;
    const serverId = container.serverId ?? container.workspace?.serverId;
    if (serverId && source.serverId !== serverId) return false;
    if (container.destinationKind === 'section') return source.kind === 'session' && Boolean(serverId);
    if (container.destinationKind === 'section-order') return source.kind === 'folder' && Boolean(serverId);
    if (container.destinationKind === 'pinned') return source.rootId === container.rootId;
    if (source.kind === 'session' && container.destinationKind === 'project') {
        const projectKey = readSessionListItemProjectKey(source.item);
        if (projectKey || container.projectKey) return Boolean(projectKey && container.projectKey
            && projectKey.serverId === source.serverId && container.projectKey.serverId === serverId
            && projectKey.serverId === container.projectKey.serverId && projectKey.projectKey === container.projectKey.projectKey);
        return Boolean(source.workspace && container.workspace
            && compareSessionFolderWorkspaceRefs(source.workspace, container.workspace));
    }
    if (source.rootId !== container.rootId) return false;
    return !source.workspace || !container.workspace
        || compareSessionFolderWorkspaceRefs(source.workspace, container.workspace);
}
