import * as React from 'react';

import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';

import { resolveRepoWorktreeSelection, type RepoWorktreeSelectionResolution } from './resolveRepoWorktreeSelection';

export function useResolvedRepoWorktreeSelection(params: Readonly<{
    serverId: string;
    machineId: string;
    defaultRootPath: string;
    requestedRootPath: string | null | undefined;
    requestedWorktreeId?: string | null | undefined;
}>): RepoWorktreeSelectionResolution & Readonly<{
    availableWorktrees: ReadonlyArray<Readonly<{ id?: string; path: string; isPrunable?: boolean }>> | null;
}> {
    const workspaceScope = React.useMemo(() => {
        if (!params.serverId || !params.machineId || !params.defaultRootPath) {
            return null;
        }
        return {
            serverId: params.serverId,
            machineId: params.machineId,
            rootPath: params.defaultRootPath,
        };
    }, [params.defaultRootPath, params.machineId, params.serverId]);
    const { snapshot } = useWorkspaceScmSnapshotController(workspaceScope);
    const availableWorktrees = snapshot?.repo?.isRepo === true
        ? (snapshot.repo.worktrees ?? [])
        : null;

    return React.useMemo(() => ({
        ...resolveRepoWorktreeSelection({
            requestedRootPath: params.requestedRootPath,
            requestedWorktreeId: params.requestedWorktreeId,
            defaultRootPath: params.defaultRootPath,
            availableWorktrees,
        }),
        availableWorktrees,
    }), [availableWorktrees, params.defaultRootPath, params.requestedRootPath, params.requestedWorktreeId]);
}
