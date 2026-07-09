import * as React from 'react';

import { useVisibleSessionListSummaryState } from './useVisibleSessionListSummaryState';
import { useVisibleSessionListViewState, type VisibleSessionListViewState } from './useVisibleSessionListViewState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

export type VisibleSessionListPaneState = Readonly<{
    summary: Readonly<{
        sessionsReady: boolean;
        sessionCount: number;
    }>;
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
    folderFocus: VisibleSessionListViewState['folderFocus'];
    showLoading: boolean;
    showEmptyState: boolean;
}>;

export type VisibleSessionListPaneStateOptions = Readonly<{
    pathname?: string;
    retainedPathname?: string | null;
    retainedVisibleSessionListIndex?: ReadonlyArray<SessionListIndexItem> | null;
    sessionListSurfaceDataActive?: boolean;
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

export function useVisibleSessionListPaneState(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListPaneStateOptions = {},
): VisibleSessionListPaneState {
    const { summary } = useVisibleSessionListSummaryState(storageFilter);
    const { visibleSessionListIndex, hasHiddenInactiveSessions, folderFocus } = useVisibleSessionListViewState(storageFilter, {
        pathname: options.pathname,
        retainedPathname: options.retainedPathname,
        retainedVisibleSessionListIndex: options.retainedVisibleSessionListIndex,
        sessionListSurfaceDataActive: options.sessionListSurfaceDataActive,
    });
    const visibleSessionCount = React.useMemo(
        () => countVisibleSessions(visibleSessionListIndex),
        [visibleSessionListIndex],
    );

    return React.useMemo(() => ({
        summary,
        visibleSessionListIndex,
        hasHiddenInactiveSessions,
        folderFocus,
        showLoading: !summary.sessionsReady,
        showEmptyState: summary.sessionsReady && visibleSessionCount === 0,
    }), [folderFocus, hasHiddenInactiveSessions, summary, visibleSessionCount, visibleSessionListIndex]);
}
