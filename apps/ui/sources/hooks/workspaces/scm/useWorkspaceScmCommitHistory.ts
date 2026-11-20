import * as React from 'react';

import { machineScmLogList } from '@/sync/ops/scm/machineScm';
import { usePagedScmCommitHistory } from '@/scm/history/usePagedScmCommitHistory';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export function useWorkspaceScmCommitHistory(input: WorkspaceScopeBase & Readonly<{
    readLogEnabled: boolean;
    historyBranch?: string | null;
}>) {
    return usePagedScmCommitHistory({
        enabled: input.readLogEnabled,
        historyIdentity: input.workspace
            ? JSON.stringify([tryBuildWorkspaceCacheKey(input), input.historyBranch ?? null])
            : JSON.stringify([input.serverId, input.machineId, input.rootPath, input.historyBranch ?? null]),
        loadPage: React.useCallback(async ({ limit, skip }) => {
            return await machineScmLogList(input.machineId, {
                cwd: input.rootPath,
                limit,
                skip,
            }, { serverId: input.serverId, workspace: input.workspace });
        }, [input.machineId, input.rootPath, input.serverId, input.workspace]),
    });
}
