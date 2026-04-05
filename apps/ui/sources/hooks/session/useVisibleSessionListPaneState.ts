import * as React from 'react';

import { useVisibleSessionListSummaryState } from './useVisibleSessionListSummaryState';
import { useVisibleSessionListViewData } from './useVisibleSessionListViewData';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

export type VisibleSessionListPaneState = Readonly<{
    summary: ReturnType<typeof useVisibleSessionListSummaryState>['summary'];
    visibleSessionListViewData: SessionListViewItem[] | null;
    showLoading: boolean;
    showEmptyState: boolean;
}>;

export function useVisibleSessionListPaneState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListPaneState {
    const { summary } = useVisibleSessionListSummaryState(storageFilter);
    const visibleSessionListViewData = useVisibleSessionListViewData(storageFilter);

    return React.useMemo(() => ({
        summary,
        visibleSessionListViewData,
        showLoading: !summary.sessionsReady,
        showEmptyState: summary.sessionsReady && summary.sessionCount === 0,
    }), [summary, visibleSessionListViewData]);
}
