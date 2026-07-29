import * as React from 'react';

import { machineScmLogList } from '@/sync/ops/scm/machineScm';
import { usePagedScmCommitHistory } from '@/scm/history/usePagedScmCommitHistory';

export function useWorkspaceScmCommitHistory(input: Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
    readLogEnabled: boolean;
}>) {
    return usePagedScmCommitHistory({
        enabled: input.readLogEnabled,
        loadPage: React.useCallback(async ({ limit, skip }) => {
            return await machineScmLogList(input.machineId, {
                cwd: input.rootPath,
                limit,
                skip,
            }, { serverId: input.serverId });
        }, [input.machineId, input.rootPath, input.serverId]),
    });
}
