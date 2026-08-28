import { buildSessionFolderTree, type SessionFolderTreeNode } from './tree';
import type { SessionFoldersV1, SessionFolderWorkspaceRefV1 } from './types';

export type SessionFolderMoveTarget = Readonly<{
    id: string;
    folderId: string | null;
    title: string;
    depth: number;
    disabled: boolean;
}>;

export type SessionFolderWorkspaceTarget = Readonly<{
    folderId: string;
    title: string;
    depth: number;
}>;

function pushFolderWorkspaceTargets(
    nodes: readonly SessionFolderTreeNode[],
    out: SessionFolderWorkspaceTarget[],
): void {
    for (const node of nodes) {
        out.push({
            folderId: node.id,
            title: node.name,
            depth: node.depth,
        });
        pushFolderWorkspaceTargets(node.children, out);
    }
}

/**
 * The one workspace-scoped folder target projection. Consumers may adapt these
 * neutral targets into a move sheet or a creation-draft picker, but workspace
 * normalization, containment and hierarchy stay owned by the folder domain.
 */
export function buildSessionFolderWorkspaceTargets(params: Readonly<{
    folders: SessionFoldersV1;
    workspace: SessionFolderWorkspaceRefV1;
}>): readonly SessionFolderWorkspaceTarget[] {
    const targets: SessionFolderWorkspaceTarget[] = [];
    pushFolderWorkspaceTargets(buildSessionFolderTree(params.folders, params.workspace).rootNodes, targets);
    return targets;
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
    targets.push(...buildSessionFolderWorkspaceTargets({
        folders: params.folders,
        workspace: params.workspace,
    }).map((target) => ({
        id: `session-folder-move-folder-${target.folderId}`,
        ...target,
        disabled: target.folderId === currentFolderId,
    })));
    return targets;
}
