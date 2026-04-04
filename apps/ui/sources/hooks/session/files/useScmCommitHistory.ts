import * as React from 'react';

import { sessionScmLogList } from '@/sync/ops';
import { usePagedScmCommitHistory } from '@/scm/history/usePagedScmCommitHistory';

export function useScmCommitHistory(input: {
    sessionId: string;
    readLogEnabled: boolean;
    sessionPath: string | null;
}) {
    return usePagedScmCommitHistory({
        enabled: input.readLogEnabled,
        loadPage: React.useCallback(async ({ limit, skip }) => {
            return await sessionScmLogList(input.sessionId, { limit, skip });
        }, [input.sessionId]),
    });
}
