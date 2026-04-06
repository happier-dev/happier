import * as React from 'react';

import { useVisibleSessionListSummaryState } from './useVisibleSessionListSummaryState';
import { useVisibleSessionListViewState } from './useVisibleSessionListViewState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

export type VisibleSessionListPaneState = Readonly<{
    summary: Readonly<{
        sessionsReady: boolean;
        sessionCount: number;
    }>;
    visibleSessionListViewData: SessionListViewItem[] | null;
    showLoading: boolean;
    showEmptyState: boolean;
}>;

export function useVisibleSessionListPaneState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListPaneState {
    const { summary } = useVisibleSessionListSummaryState(storageFilter);
    const { visibleSessionListViewData } = useVisibleSessionListViewState(storageFilter);

    return React.useMemo(() => ({
        summary,
        visibleSessionListViewData,
        showLoading: !summary.sessionsReady,
        showEmptyState: summary.sessionsReady && summary.sessionCount === 0,
    }), [summary, visibleSessionListViewData]);
}
