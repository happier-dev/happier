import {
    buildSessionFolderMoveTargets,
    compareSessionFolderWorkspaceRefs,
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFoldersV1,
    type SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { sessionTagKey } from '../sessionTagUtils';

export function resolveSessionListFolderMoveTargets(params: Readonly<{
    items: readonly SessionListViewItem[];
    sessionKeys: ReadonlySet<string>;
    folders: SessionFoldersV1;
    assignmentsBySessionKey: Readonly<Record<string, string | null>>;
    workspaceRootTitle: string;
}>) {
    const selected = params.items.filter((item): item is Extract<SessionListViewItem, { type: 'session' }> => (
        item.type === 'session' && Boolean(item.serverId)
        && params.sessionKeys.has(sessionTagKey(item.serverId!, item.session.id))
    ));
    if (selected.length === 0) return [];
    const workspaces = selected.map((item) => {
        if (item.workspace) return item.workspace;
        const header = params.items.find((candidate) => candidate.type === 'header'
            && candidate.serverId === item.serverId && candidate.groupKey === item.groupKey);
        if (header?.type === 'header') {
            const workspace = header.workspace ?? resolveDurableWorkspaceRefForSessionListHeader(header);
            if (workspace) return workspace;
        }
        return null;
    });
    const firstWorkspace = workspaces[0] ?? null;
    // Removing an assignment is valid across workspaces. Folder destinations must belong to all selected sessions.
    const workspace: SessionFolderWorkspaceRefV1 | null = firstWorkspace && workspaces.every((candidate) => (
        candidate !== null && compareSessionFolderWorkspaceRefs(candidate, firstWorkspace)
    )) ? firstWorkspace : null;
    return buildSessionFolderMoveTargets({
        folders: params.folders, workspace,
        currentFolderIds: selected.map((item) => params.assignmentsBySessionKey[sessionTagKey(item.serverId!, item.session.id)] ?? null),
        workspaceRootTitle: params.workspaceRootTitle,
    });
}
