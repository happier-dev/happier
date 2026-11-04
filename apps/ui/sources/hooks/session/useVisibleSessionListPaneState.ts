import * as React from 'react';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { CollectionConditionValueCountRequest, CollectionConditionValueCounts } from '@happier-dev/plugin-ui/components';

import { useSettlingHomeServerId } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { useVisibleSessionListSummaryState } from './useVisibleSessionListSummaryState';
import { useVisibleSessionListViewState, type VisibleSessionListViewState, type VisibleSessionListViewStateOptions } from './useVisibleSessionListViewState';
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
    filterResult?: EntityListFilterResultV1;
    conditionValueCounts?: CollectionConditionValueCounts;
    onConditionValueCountRequest?: (request: CollectionConditionValueCountRequest | null) => void;
    filterMatchedEntityIds?: ReadonlySet<string>;
    filterAttentionSupplementEntityIds?: ReadonlySet<string>;
    hasHiddenInactiveSessions: boolean;
    folderFeatureEnabledServerIds: VisibleSessionListViewState['folderFeatureEnabledServerIds'];
    showLoading: boolean;
    showEmptyState: boolean;
    query?: VisibleSessionListViewState['query'];
    queryPresentation?: SessionListQueryPresentation;
    workflowRunWindow?: VisibleSessionListViewState['workflowRunWindow'];
}>;

export type VisibleSessionListPaneStateOptions = Readonly<{
    collapseContextKey?: string;
    pathname?: string;
    retainedPathname?: string | null;
    retainedVisibleSessionListIndex?: ReadonlyArray<SessionListIndexItem> | null;
    sessionListSurfaceDataActive?: boolean;
    attentionInteractionHeld?: boolean;
    supplementalNeedsYouSessionKeys?: ReadonlySet<string>;
    includeNeedsYouEverywhere?: boolean;
    fixedTeam?: VisibleSessionListViewStateOptions['fixedTeam'];
    queryHomes?: VisibleSessionListSourceStateOptions['queryHomes'];
    emptyQuerySelectionComplete?: boolean;
    corpusStorage?: 'active' | 'archived';
    workFilter?: SessionListFilterV1;
    spaceMembership?: VisibleSessionListViewStateOptions['spaceMembership'];
    /** The filter controller keeps search and narrowing recovery on the mounted list. */
    filterControlsRequired?: boolean;
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
    // This pane already owns the retained projection/subscription. The editor supplies
    // demand, never rows; a closed/hidden value list adds no fact work or reads.
    const [conditionValueCountRequest, setConditionValueCountRequest] = React.useState<CollectionConditionValueCountRequest | null>(null);
    const { summary: ordinarySummary } = useVisibleSessionListSummaryState(storageFilter);
    const { visibleSessionListIndex, filterResult: localFilterResult, conditionValueCounts, filterMatchedEntityIds, filterAttentionSupplementEntityIds, hasHiddenInactiveSessions, folderFeatureEnabledServerIds, query, workflowRunWindow, workflowRunUnavailableHomes } = useVisibleSessionListViewState(storageFilter, {
        conditionValueCountRequest: options.sessionListSurfaceDataActive === false ? undefined : conditionValueCountRequest ?? undefined,
        collapseContextKey: options.collapseContextKey,
        pathname: options.pathname,
        retainedPathname: options.retainedPathname,
        retainedVisibleSessionListIndex: options.retainedVisibleSessionListIndex,
        sessionListSurfaceDataActive: options.sessionListSurfaceDataActive,
        attentionInteractionHeld: options.attentionInteractionHeld,
        supplementalNeedsYouSessionKeys: options.supplementalNeedsYouSessionKeys,
        includeNeedsYouEverywhere: options.includeNeedsYouEverywhere,
        fixedTeam: options.fixedTeam,
        queryHomes: options.queryHomes,
        emptyQuerySelectionComplete: options.emptyQuerySelectionComplete,
        corpusStorage: options.corpusStorage,
        workFilter: options.workFilter,
        spaceMembership: options.spaceMembership,
        botsRoster: options.botsRoster,
    });
    const visibleSessionCount = React.useMemo(
        () => countVisibleSessions(visibleSessionListIndex),
        [visibleSessionListIndex],
    );
    const settlingHomeServerId = useSettlingHomeServerId();
    const queryPresentation = React.useMemo(() => query?.active === true || workflowRunWindow !== undefined || (workflowRunUnavailableHomes?.length ?? 0) > 0
        ? resolveSessionListQueryPresentation({
            selectedServerIds: (options.queryHomes ?? []).map((home) => home.serverId),
            statesByServerId: query?.statesByServerId ?? {},
            coverageComplete: query?.active === true ? query.coverageComplete : ordinarySummary.sessionsReady,
            retainedRowCount: visibleSessionCount,
            sessionsEnabled: options.botsRoster === true || options.workFilter?.show !== 'runs',
            workflowRunWindow,
            workflowRunUnavailableHomes,
            settlingHomeServerId,
        })
        : undefined, [settlingHomeServerId, options.botsRoster, options.queryHomes, options.workFilter?.show, ordinarySummary.sessionsReady, query, visibleSessionCount, workflowRunWindow, workflowRunUnavailableHomes]);
    const summary = React.useMemo(() => queryPresentation
        ? {
            sessionsReady: queryPresentation.kind !== 'initial_loading',
            sessionCount: visibleSessionCount,
        }
        : ordinarySummary, [ordinarySummary, queryPresentation, visibleSessionCount]);
    const queryActive = queryPresentation !== undefined;
    const filterResult = React.useMemo<EntityListFilterResultV1>(() => {
        if (!queryPresentation || queryPresentation.kind === 'ready' && queryPresentation.complete) return localFilterResult;
        if (localFilterResult.coverage === 'unavailable') return localFilterResult;
        const coverage = queryPresentation.kind === 'initial_loading'
            || queryPresentation.kind === 'error' && !queryPresentation.retainedRows ? 'unavailable' : 'partial';
        return localFilterResult.coverage === coverage ? localFilterResult : { ...localFilterResult, coverage };
    }, [localFilterResult, queryPresentation]);

    return React.useMemo(() => ({
        summary,
        visibleSessionListIndex,
        filterResult,
        conditionValueCounts,
        onConditionValueCountRequest: setConditionValueCountRequest,
        filterMatchedEntityIds,
        filterAttentionSupplementEntityIds,
        hasHiddenInactiveSessions,
        folderFeatureEnabledServerIds,
        // Query loading stays inside the mounted canonical list so search focus,
        // filters, and virtualizer identity survive query changes.
        showLoading: !queryActive && !summary.sessionsReady,
        // A complete, unnarrowed query zero is also an empty library. Pending,
        // incomplete and narrowed results keep the list and its recovery controls.
        showEmptyState: summary.sessionsReady && visibleSessionCount === 0 && (!queryActive
            || options.filterControlsRequired === false && queryPresentation?.kind === 'ready' && queryPresentation.complete),
        query,
        queryPresentation,
        workflowRunWindow,
    }), [conditionValueCounts, filterResult, filterMatchedEntityIds, filterAttentionSupplementEntityIds, folderFeatureEnabledServerIds, hasHiddenInactiveSessions, options.filterControlsRequired, query, queryActive, queryPresentation, summary, visibleSessionCount, visibleSessionListIndex, workflowRunWindow]);
}
