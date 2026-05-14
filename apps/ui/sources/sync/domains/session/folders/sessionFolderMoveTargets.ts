import { buildSessionFolderTree, type SessionFolderTreeNode } from './tree';
import type { SessionFoldersV1, SessionFolderWorkspaceRefV1 } from './types';

export type SessionFolderMoveTarget = Readonly<{
    id: string;
    folderId: string | null;
    title: string;
    depth: number;
    disabled: boolean;
}>;

function pushFolderTargets(
    nodes: readonly SessionFolderTreeNode[],
    currentFolderId: string | null,
    out: SessionFolderMoveTarget[],
): void {
    for (const node of nodes) {
        out.push({
            id: `session-folder-move-folder-${node.id}`,
            folderId: node.id,
            title: node.name,
            depth: node.depth,
            disabled: node.id === currentFolderId,
        });
        pushFolderTargets(node.children, currentFolderId, out);
    }
}

export function buildSessionFolderMoveTargets(params: Readonly<{
    folders: SessionFoldersV1;
    workspace: SessionFolderWorkspaceRefV1;
    currentFolderId: string | null | undefined;
    workspaceRootTitle: string;
}>): readonly SessionFolderMoveTarget[] {
    const currentFolderId = params.currentFolderId ?? null;
    const targets: SessionFolderMoveTarget[] = [{
        id: 'session-folder-move-root',
        folderId: null,
        title: params.workspaceRootTitle,
        depth: 0,
        disabled: currentFolderId === null,
    }];
    pushFolderTargets(buildSessionFolderTree(params.folders, params.workspace).rootNodes, currentFolderId, targets);
    return targets;
}
