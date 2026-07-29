import * as React from 'react';

import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { useWorkspaceRepositoryTreeRowActions } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions';

import type { RepositoryTreeRowActionMenuItemId } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';

type RepositoryTreeNodeLike = Readonly<{
    path: string;
    type: 'file' | 'directory';
}>;

export function useRepositoryTreeRowActions(params: Readonly<{
    sessionId: string;
    writeActionsEnabled: boolean;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string; canceled?: true }>) | null;
}>): Readonly<{
    onSelectRowMenuItem: (node: RepositoryTreeNodeLike, itemId: RepositoryTreeRowActionMenuItemId) => Promise<void>;
}> {
    const workspaceTarget = resolveWorkspaceTargetForSession(params.sessionId);
    const workspaceScope = React.useMemo(() => (
        workspaceTarget
            ? {
                serverId: workspaceTarget.serverId,
                machineId: workspaceTarget.machineId,
                rootPath: workspaceTarget.rootPath,
            }
            : null
    ), [workspaceTarget?.machineId, workspaceTarget?.rootPath, workspaceTarget?.serverId]);

    return useWorkspaceRepositoryTreeRowActions({
        workspaceScope,
        writeActionsEnabled: params.writeActionsEnabled,
        expandedPaths: params.expandedPaths,
        onExpandedPathsChange: params.onExpandedPathsChange,
        onRequestRefresh: params.onRequestRefresh,
        onRequestDownload: params.onRequestDownload,
    });
}
