import { buildSessionFolderWorkspaceRefKey } from './workspaceRefs';
import type { SessionFolderWorkspaceRefV1 } from './types';

export function buildSessionFolderCollapseKey(params: Readonly<{
    serverId: string | null | undefined;
    workspace: SessionFolderWorkspaceRefV1;
    folderId: string;
}>): string {
    const serverId = String(params.serverId ?? params.workspace.serverId ?? 'local').trim() || 'local';
    return `folder:${serverId}:${buildSessionFolderWorkspaceRefKey(params.workspace)}:${params.folderId}`;
}
