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
    visibleSessionListIndex: SessionListIndexItem[] | null;
    showLoading: boolean;
    showEmptyState: boolean;
}>;

export function useVisibleSessionListPaneState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListPaneState {
    const { summary } = useVisibleSessionListSummaryState(storageFilter);
    const { visibleSessionListIndex } = useVisibleSessionListViewState(storageFilter);

    return React.useMemo(() => ({
        summary,
        visibleSessionListIndex,
        showLoading: !summary.sessionsReady,
        showEmptyState: summary.sessionsReady && summary.sessionCount === 0,
    }), [summary, visibleSessionListIndex]);
}
