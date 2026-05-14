import type { SessionFolderV1, SessionFoldersV1, SessionFolderWorkspaceRefV1 } from './types';
import { compareSessionFolderWorkspaceRefs } from './workspaceRefs';

export type SessionFolderTreeNode = SessionFolderV1 & Readonly<{
    depth: number;
    children: readonly SessionFolderTreeNode[];
}>;

export type SessionFolderTree = Readonly<{
    rootNodes: readonly SessionFolderTreeNode[];
    nodesById: ReadonlyMap<string, SessionFolderTreeNode>;
}>;

function compareFolders(a: SessionFolderV1, b: SessionFolderV1): number {
    const sortA = a.sortKey ?? a.name.toLocaleLowerCase();
    const sortB = b.sortKey ?? b.name.toLocaleLowerCase();
    if (sortA !== sortB) return sortA.localeCompare(sortB);
    return a.id.localeCompare(b.id);
}

export function buildSessionFolderTree(folders: SessionFoldersV1, workspace: SessionFolderWorkspaceRefV1): SessionFolderTree {
    const workspaceFolders = folders.folders
        .filter((folder) => compareSessionFolderWorkspaceRefs(folder.workspace, workspace))
        .slice()
        .sort(compareFolders);
    const childFoldersByParentId = new Map<string | null, SessionFolderV1[]>();
    for (const folder of workspaceFolders) {
        const siblings = childFoldersByParentId.get(folder.parentId) ?? [];
        siblings.push(folder);
        childFoldersByParentId.set(folder.parentId, siblings);
    }

    const nodesById = new Map<string, SessionFolderTreeNode>();
    const buildNode = (folder: SessionFolderV1, depth: number): SessionFolderTreeNode => {
        const children = (childFoldersByParentId.get(folder.id) ?? []).map((child) => buildNode(child, depth + 1));
        const node: SessionFolderTreeNode = { ...folder, depth, children };
        nodesById.set(folder.id, node);
        return node;
    };

    return {
        rootNodes: (childFoldersByParentId.get(null) ?? []).map((folder) => buildNode(folder, 0)),
        nodesById,
    };
}
