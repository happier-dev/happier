import * as React from 'react';

import { useVisibleSessionListSummaryState } from './useVisibleSessionListSummaryState';
import { useVisibleSessionListViewState } from './useVisibleSessionListViewState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

export type VisibleSessionListPaneState = Readonly<{
    summary: Readonly<{
        sessionsReady: boolean;
        sessionCount: number;
    }>;
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
    showLoading: boolean;
    showEmptyState: boolean;
}>;

function countVisibleSessions(index: ReadonlyArray<SessionListIndexItem> | null): number {
    if (!index) return 0;
    let count = 0;
    for (const item of index) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

export function useVisibleSessionListPaneState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListPaneState {
    const { summary } = useVisibleSessionListSummaryState(storageFilter);
    const { visibleSessionListIndex, hasHiddenInactiveSessions } = useVisibleSessionListViewState(storageFilter);
    const visibleSessionCount = React.useMemo(
        () => countVisibleSessions(visibleSessionListIndex),
        [visibleSessionListIndex],
    );

    return React.useMemo(() => ({
        summary,
        visibleSessionListIndex,
        hasHiddenInactiveSessions,
        showLoading: !summary.sessionsReady,
        showEmptyState: summary.sessionsReady && visibleSessionCount === 0,
    }), [hasHiddenInactiveSessions, summary, visibleSessionCount, visibleSessionListIndex]);
}
