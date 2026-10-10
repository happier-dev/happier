import * as React from 'react';
import type { SessionListFilterV1 } from '@happier-dev/protocol';

import { useVisibleSessionListSummaryState } from './useVisibleSessionListSummaryState';
import { useVisibleSessionListViewState, type VisibleSessionListViewState } from './useVisibleSessionListViewState';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { VisibleSessionListSourceStateOptions } from './useVisibleSessionListSourceState';
import {
    resolveSessionListQueryPresentation,
    type SessionListQueryPresentation,
} from '@/sync/domains/session/listing/sessionListIndexPresentation';

export type VisibleSessionListPaneState = Readonly<{
    summary: Readonly<{
        sessionsReady: boolean;
        sessionCount: number;
    }>;
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
    folderFocus: VisibleSessionListViewState['folderFocus'];
    folderFeatureEnabledServerIds: VisibleSessionListViewState['folderFeatureEnabledServerIds'];
    showLoading: boolean;
    showEmptyState: boolean;
    query?: VisibleSessionListViewState['query'];
    queryPresentation?: SessionListQueryPresentation;
    workflowRunWindow?: VisibleSessionListViewState['workflowRunWindow'];
}>;

export type VisibleSessionListPaneStateOptions = Readonly<{
    pathname?: string;
    retainedPathname?: string | null;
    retainedVisibleSessionListIndex?: ReadonlyArray<SessionListIndexItem> | null;
    sessionListSurfaceDataActive?: boolean;
    queryHomes?: VisibleSessionListSourceStateOptions['queryHomes'];
    emptyQuerySelectionComplete?: boolean;
    corpusStorage?: 'active' | 'archived';
    workFilter?: SessionListFilterV1;
    /** The opened Bots leaf uses ordinary rows/query paging with Bot-only, inactive-inclusive presentation. */
    botsRoster?: true;
}>;

function countVisibleSessions(index: ReadonlyArray<SessionListIndexItem> | null): number {
    if (!index) return 0;
    let count = 0;
    for (const item of index) {
        if (item.type === 'session' || item.type === 'workflow_run') {
            count += 1;
        }
    }
    return count;
}

export function useVisibleSessionListPaneState(
    storageFilter: SessionListStorageFilter = 'all',
    options: VisibleSessionListPaneStateOptions = {},
): VisibleSessionListPaneState {
    const { summary: ordinarySummary } = useVisibleSessionListSummaryState(storageFilter);
    const { visibleSessionListIndex, hasHiddenInactiveSessions, folderFocus, folderFeatureEnabledServerIds, query, workflowRunWindow, workflowRunUnavailableHomes } = useVisibleSessionListViewState(storageFilter, {
        pathname: options.pathname,
        retainedPathname: options.retainedPathname,
        retainedVisibleSessionListIndex: options.retainedVisibleSessionListIndex,
        sessionListSurfaceDataActive: options.sessionListSurfaceDataActive,
        queryHomes: options.queryHomes,
        emptyQuerySelectionComplete: options.emptyQuerySelectionComplete,
        corpusStorage: options.corpusStorage,
        workFilter: options.workFilter,
        botsRoster: options.botsRoster,
    });
    const visibleSessionCount = React.useMemo(
        () => countVisibleSessions(visibleSessionListIndex),
        [visibleSessionListIndex],
    );
    const queryPresentation = React.useMemo(() => query?.active === true || workflowRunWindow !== undefined || (workflowRunUnavailableHomes?.length ?? 0) > 0
        ? resolveSessionListQueryPresentation({
            selectedServerIds: (options.queryHomes ?? []).map((home) => home.serverId),
            statesByServerId: query?.statesByServerId ?? {},
            coverageComplete: query?.active === true ? query.coverageComplete : ordinarySummary.sessionsReady,
            retainedRowCount: visibleSessionCount,
            sessionsEnabled: options.botsRoster === true || options.workFilter?.show !== 'runs',
            workflowRunWindow,
            workflowRunUnavailableHomes,
        })
        : undefined, [options.botsRoster, options.queryHomes, options.workFilter?.show, ordinarySummary.sessionsReady, query, visibleSessionCount, workflowRunWindow, workflowRunUnavailableHomes]);
    const summary = React.useMemo(() => queryPresentation
        ? {
            sessionsReady: queryPresentation.kind !== 'initial_loading',
            sessionCount: visibleSessionCount,
        }
        : ordinarySummary, [ordinarySummary, queryPresentation, visibleSessionCount]);
    const queryActive = queryPresentation !== undefined;

    return React.useMemo(() => ({
        summary,
        visibleSessionListIndex,
        hasHiddenInactiveSessions,
        folderFocus,
        folderFeatureEnabledServerIds,
        // Query loading stays inside the mounted canonical list so search focus,
        // filters, and virtualizer identity survive query changes.
        showLoading: !queryActive && !summary.sessionsReady,
        // A query zero belongs to the canonical list surface so its filter
        // control, completeness/error treatment and recovery actions remain
        // available. Onboarding is only an ordinary-library empty state.
        showEmptyState: !queryActive && summary.sessionsReady && visibleSessionCount === 0,
        query,
        queryPresentation,
        workflowRunWindow,
    }), [folderFeatureEnabledServerIds, folderFocus, hasHiddenInactiveSessions, query, queryActive, queryPresentation, summary, visibleSessionCount, visibleSessionListIndex, workflowRunWindow]);
}
