import type { SessionFolderV1, SessionFoldersV1, SessionFolderWorkspaceRefV1 } from './types';
import { compareSessionFolderWorkspaceRefs } from './workspaceRefs';

export type SessionFolderFocusScope = Readonly<{
    folder: SessionFolderV1;
    folderIds: ReadonlySet<string>;
    breadcrumbs: readonly SessionFolderV1[];
}>;

function collectDescendants(folderId: string, folders: readonly SessionFolderV1[], output: Set<string>): void {
    output.add(folderId);
    for (const folder of folders) {
        if (folder.parentId === folderId && !output.has(folder.id)) {
            collectDescendants(folder.id, folders, output);
        }
    }
}

export function resolveSessionFolderFocusScope(
    folders: SessionFoldersV1,
    focus: Readonly<{
        folderId: string;
        workspace: SessionFolderWorkspaceRefV1;
        serverId?: string | null;
    }> | null,
): SessionFolderFocusScope | null {
    if (!focus) return null;
    const folder = folders.folders.find((candidate) => (
        candidate.id === focus.folderId
        && compareSessionFolderWorkspaceRefs(candidate.workspace, focus.workspace)
    ));
    if (!folder) return null;

    const byId = new Map(folders.folders.map((candidate) => [candidate.id, candidate] as const));
    const breadcrumbs: SessionFolderV1[] = [];
    let current: SessionFolderV1 | undefined = folder;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        breadcrumbs.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    const folderIds = new Set<string>();
    collectDescendants(folder.id, folders.folders, folderIds);
    return { folder, folderIds, breadcrumbs };
}
