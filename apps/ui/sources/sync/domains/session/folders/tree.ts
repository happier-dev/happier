import type {
    SessionFolderList,
    SessionFolderListItem,
    SessionFolderWorkspaceRefV1,
} from './types';
import { compareSessionFolderWorkspaceRefs } from './workspaceRefs';

export type SessionFolderTreeNode = SessionFolderListItem & Readonly<{
    depth: number;
    children: readonly SessionFolderTreeNode[];
}>;

export type SessionFolderTree = Readonly<{
    rootNodes: readonly SessionFolderTreeNode[];
    nodesById: ReadonlyMap<string, SessionFolderTreeNode>;
}>;

function compareFolders(a: SessionFolderListItem, b: SessionFolderListItem): number {
    const sortA = a.sortKey ?? a.name.toLocaleLowerCase();
    const sortB = b.sortKey ?? b.name.toLocaleLowerCase();
    if (sortA !== sortB) return sortA.localeCompare(sortB);
    return a.id.localeCompare(b.id);
}

export function buildSessionFolderTree(
    folders: SessionFolderList,
    workspace: SessionFolderWorkspaceRefV1,
    options: Readonly<{
        includeLockedFolderIds?: ReadonlySet<string>;
    }> = {},
): SessionFolderTree {
    const workspaceFolders = folders.folders
        .filter((folder) => folder.workspace
            ? compareSessionFolderWorkspaceRefs(folder.workspace, workspace)
            : options.includeLockedFolderIds?.has(folder.id) === true)
        .slice()
        .sort(compareFolders);
    const childFoldersByParentId = new Map<string | null, SessionFolderListItem[]>();
    for (const folder of workspaceFolders) {
        const siblings = childFoldersByParentId.get(folder.parentId) ?? [];
        siblings.push(folder);
        childFoldersByParentId.set(folder.parentId, siblings);
    }

    const nodesById = new Map<string, SessionFolderTreeNode>();
    const buildNode = (folder: SessionFolderListItem, depth: number): SessionFolderTreeNode => {
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
