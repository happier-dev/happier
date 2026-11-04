import React from 'react';
import { View, Platform, RefreshControl } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { sessionListStyles } from './sessionListStyles';
import { SessionListDropOverlay } from './drag/SessionListDropOverlay';
import { SessionListVirtualizedContent } from './sessionListVirtualizedContent';
import { ScheduledWorkflowSection } from '@/components/workflows/triggers/ScheduledWorkflowSection';
import { SessionListSearchChrome } from './search/SessionListSearchChrome';
import { buildSessionListActiveFilterChips, readSessionListWorkFilterSummary } from './search/SessionListFilterControl';
import { Icon } from '@/components/ui/icons/Icon';
import {
    SessionListAttentionInteractionContext,
    useSessionListAttentionInteractionHeld,
    useSessionListAttentionInteractionOwner,
} from './useSessionListAttentionInteraction';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import {
    useSessionListViewFilterController,
    type SessionListCorpusStorage,
    type SessionListViewFilterController,
} from './search/useSessionListViewFilterController';
import { preloadEnrichedMarkdownRuntime } from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { SessionListExternalStatusDemandPublisher, useSessionListViewStateFromPaneState } from './useSessionListViewState';
import {
    releaseSessionListScrollRetention,
    useSessionListScrollRetention,
} from './scroll/useSessionListScrollRetention';
import { buildSessionListRetentionKey } from './scroll/sessionListRetentionKey';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { useSessionListLayoutChoice } from '@/hooks/session/sessionListLayoutIntent';
import { buildSessionListCollapseContextKey } from '@/sync/domains/session/listing/sessionListCollapseState';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runRefreshDiagnosticAction } from '@/utils/system/userInteractionDiagnostics';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import {
    normalizeSessionListSurfaceOwnership,
    type SessionListSurfaceOwnership,
} from './surface/sessionListSurfaceOwnership';
import { SessionListSelectionStoreProvider } from './selection/SessionListSelectionContext';
import { SessionListOrganizeModeProvider, useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';
import { SessionListOrganizeBar } from './organize/SessionListOrganizeBar';
import { SessionListStagedMoveDock, SessionListStagedMoveProvider } from './keyboardMove/SessionListStagedMoveDock';
import { SessionListSelectionActionBarHost } from './selection/SessionListSelectionActionBar';
import { KeyboardAwareScreen } from '@/components/ui/keyboardAvoidance/KeyboardAwareScreen';
import { SessionSectionDraftContext, useSessionSectionDraftController } from '@/components/sessions/organization/useSessionSectionDraft';
import {
    readRetainedSessionListPaneState,
    releaseRetainedSessionListPaneState,
    retainSessionListPaneState,
    setRetainedSessionListPaneQueryMembershipActive,
    setRetainedSessionListPaneReferenceCorpusActive,
} from './sessionListPaneRetention';
import type { SessionListViewContext } from './search/sessionListViewFilters';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import {
    registerSessionListRouteRemovalRelease,
    type SessionListRouteRemovalNavigation,
} from './sessionListRouteRetention';

const SESSION_LIST_END_REACHED_THRESHOLD_RATIO = 0.4;

type SessionListScrollNearEndEvent = Readonly<{
    nativeEvent?: Readonly<{
        contentOffset?: Readonly<{ y?: number }>;
        contentSize?: Readonly<{ height?: number }>;
        layoutMeasurement?: Readonly<{ height?: number }>;
    }>;
}>;

function isSessionListScrollNearEnd(event: SessionListScrollNearEndEvent): boolean {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent ?? {};
    const offsetY = typeof contentOffset?.y === 'number' ? contentOffset.y : 0;
    const contentHeight = typeof contentSize?.height === 'number' ? contentSize.height : 0;
    const viewportHeight = typeof layoutMeasurement?.height === 'number' ? layoutMeasurement.height : 0;
    if (contentHeight <= 0 || viewportHeight <= 0) return false;

    const thresholdPx = Math.max(1, viewportHeight * SESSION_LIST_END_REACHED_THRESHOLD_RATIO);
    return offsetY + viewportHeight >= contentHeight - thresholdPx;
}

function buildSessionListViewRetentionKey(params: Readonly<{
    storageKind: SessionListStorageFilter;
    sourceScopeKey: string;
    viewContextKey: string;
    corpusStorage: SessionListCorpusStorage;
}>): string {
    return buildSessionListRetentionKey(
        params.storageKind,
        JSON.stringify([
            params.sourceScopeKey,
            'context',
            params.viewContextKey,
            'corpus',
            params.corpusStorage,
        ]),
    );
}

export function SessionsList(props: Readonly<{
    fixedShow?: SessionListFilterV1['show'];
    storageKind?: SessionListStorageFilter;
    corpusStorage?: SessionListCorpusStorage;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
    viewContext?: SessionListViewContext;
    releaseRetentionOnRouteRemoval?: boolean;
}>) {
    return <SessionsListView {...props} />;
}

export function SessionsListView(props: Readonly<{
    fixedShow?: SessionListFilterV1['show'];
    storageKind?: SessionListStorageFilter;
    corpusStorage?: SessionListCorpusStorage;
    paneState?: VisibleSessionListPaneState;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
    viewContext?: SessionListViewContext;
    releaseRetentionOnRouteRemoval?: boolean;
}>) {
    const corpusStorage = props.corpusStorage ?? 'active';
    const filterController = useSessionListViewFilterController(corpusStorage, props.viewContext, props.fixedShow);

    return (
        <SessionsListViewWithFilterController
            {...props}
            corpusStorage={corpusStorage}
            filterController={filterController}
        />
    );
}

export function SessionsListViewWithFilterController(props: Readonly<{
    storageKind?: SessionListStorageFilter;
    corpusStorage: SessionListCorpusStorage;
    filterController: SessionListViewFilterController;
    paneState?: VisibleSessionListPaneState;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
    releaseRetentionOnRouteRemoval?: boolean;
}>) {
    const attentionInteraction = useSessionListAttentionInteractionOwner();
    React.useEffect(() => {
        fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'SessionsList.preloadEnrichedMarkdownRuntime' });
    }, []);

    const filterController = props.filterController;
    const corpusStorage = props.corpusStorage;
    const storageKind = filterController.sourceAvailable ? filterController.displayFilters.source : 'persisted';
    if (props.paneState) {
        return (
            <SessionListAttentionInteractionContext.Provider value={attentionInteraction}>
            <SessionsListViewContent
                storageKind={storageKind}
                corpusStorage={corpusStorage}
                filterController={filterController}
                paneState={props.paneState}
                pathname={props.pathname}
                surfaceOwnership={props.surfaceOwnership}
            />
            </SessionListAttentionInteractionContext.Provider>
        );
    }

    return (
        <SessionListAttentionInteractionContext.Provider value={attentionInteraction}>
        <SessionsListViewWithResolvedPaneState
            storageKind={storageKind}
            corpusStorage={corpusStorage}
            filterController={filterController}
            pathname={props.pathname}
            surfaceOwnership={props.surfaceOwnership}
            releaseRetentionOnRouteRemoval={props.releaseRetentionOnRouteRemoval}
        />
        </SessionListAttentionInteractionContext.Provider>
    );
}

function SessionsListViewWithResolvedPaneState(props: Readonly<{
    storageKind: SessionListStorageFilter;
    corpusStorage: SessionListCorpusStorage;
    filterController: SessionListViewFilterController;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
    releaseRetentionOnRouteRemoval?: boolean;
}>) {
    const attentionInteraction = React.useContext(SessionListAttentionInteractionContext);
    const attentionInteractionHeld = useSessionListAttentionInteractionHeld(attentionInteraction);
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    const sourceScopeKey = props.filterController.retentionScopeKey;
    const layout = useSessionListLayoutChoice();
    const collapseContextKey = buildSessionListCollapseContextKey(props.filterController, layout);
    const retentionIdentity = React.useMemo(() => ({
        storageKind: props.storageKind,
        pathname: props.pathname,
        sourceScopeKey,
    }), [props.pathname, props.storageKind, sourceScopeKey]);
    const paneState = useVisibleSessionListPaneState(props.storageKind, {
        collapseContextKey,
        pathname: props.pathname,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
        attentionInteractionHeld: surfaceOwnership.interactive && attentionInteractionHeld,
        queryHomes: props.filterController.pagingHomes,
        emptyQuerySelectionComplete: props.filterController.emptyQuerySelectionComplete,
        corpusStorage: props.corpusStorage,
        workFilter: props.filterController.displayFilters,
        spaceMembership: props.filterController.spaceMembership,
        filterControlsRequired: props.filterController.filterControlsRequired,
    });
    React.useEffect(() => {
        if (!surfaceOwnership.dataActive) return;
        retainSessionListPaneState({
            storageKind: props.storageKind,
            pathname: props.pathname,
            sourceScopeKey,
            paneState,
            queryMembershipActive: true,
            referenceCorpusActive: surfaceOwnership.interactive,
            selectedServerIds: props.filterController.queryHomes.map((home) => home.serverId),
        });
    }, [paneState, props.filterController.queryHomes, props.pathname, props.storageKind, sourceScopeKey, surfaceOwnership.dataActive, surfaceOwnership.interactive]);
    React.useEffect(() => {
        setRetainedSessionListPaneQueryMembershipActive(retentionIdentity, surfaceOwnership.dataActive);
        return () => setRetainedSessionListPaneQueryMembershipActive(retentionIdentity, false);
    }, [retentionIdentity, surfaceOwnership.dataActive]);
    React.useEffect(() => {
        setRetainedSessionListPaneReferenceCorpusActive(retentionIdentity, surfaceOwnership.interactive);
        return () => setRetainedSessionListPaneReferenceCorpusActive(retentionIdentity, false);
    }, [retentionIdentity, surfaceOwnership.interactive]);
    const renderedPaneState = surfaceOwnership.dataActive
        ? paneState
        : readRetainedSessionListPaneState(retentionIdentity)?.paneState ?? paneState;
    return (
        <>
            {props.releaseRetentionOnRouteRemoval ? (
                <SessionListRouteRetentionRelease
                    corpusStorage={props.corpusStorage}
                    retentionIdentity={retentionIdentity}
                    viewContextKey={props.filterController.viewContextKey}
                />
            ) : null}
            <SessionsListViewContent
                storageKind={props.storageKind}
                corpusStorage={props.corpusStorage}
                filterController={props.filterController}
                paneState={renderedPaneState}
                pathname={props.pathname}
                surfaceOwnership={surfaceOwnership}
            />
        </>
    );
}

function SessionListRouteRetentionRelease(props: Readonly<{
    corpusStorage: SessionListCorpusStorage;
    retentionIdentity: Readonly<{
        storageKind: SessionListStorageFilter;
        pathname?: string;
        sourceScopeKey: string;
    }>;
    viewContextKey: string;
}>) {
    const navigation = useNavigation() as SessionListRouteRemovalNavigation;
    const scrollRetentionKey = React.useMemo(
        () => buildSessionListViewRetentionKey({
            storageKind: props.retentionIdentity.storageKind,
            sourceScopeKey: props.retentionIdentity.sourceScopeKey,
            viewContextKey: props.viewContextKey,
            corpusStorage: props.corpusStorage,
        }),
        [props.corpusStorage, props.retentionIdentity, props.viewContextKey],
    );
    const routeEntriesRef = React.useRef(new Map<string, Readonly<{
        paneIdentity: typeof props.retentionIdentity;
        scrollRetentionKey: string;
    }>>());
    const routeEntryKey = JSON.stringify([
        props.retentionIdentity.storageKind,
        props.retentionIdentity.pathname ?? '/',
        props.retentionIdentity.sourceScopeKey,
        scrollRetentionKey,
    ]);
    routeEntriesRef.current.set(routeEntryKey, {
        paneIdentity: props.retentionIdentity,
        scrollRetentionKey,
    });

    React.useEffect(() => registerSessionListRouteRemovalRelease(navigation, () => {
        for (const entry of routeEntriesRef.current.values()) {
            releaseRetainedSessionListPaneState(entry.paneIdentity);
            releaseSessionListScrollRetention(entry.scrollRetentionKey);
        }
        routeEntriesRef.current.clear();
    }), [navigation]);

    return null;
}

type SessionsListViewContentProps = Readonly<{
    storageKind: SessionListStorageFilter;
    corpusStorage: SessionListCorpusStorage;
    filterController: SessionListViewFilterController;
    paneState: VisibleSessionListPaneState;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>;

function SessionsListViewContent(props: SessionsListViewContentProps) {
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    if (!surfaceOwnership.visible) return null;

    return (
        <VisibleSessionsListViewContent
            {...props}
            surfaceOwnership={surfaceOwnership}
        />
    );
}

function VisibleSessionsListViewContent(
    props: Omit<SessionsListViewContentProps, 'surfaceOwnership'> & Readonly<{
        surfaceOwnership: SessionListSurfaceOwnership;
    }>,
) {
    const styles = sessionListStyles;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const runsPresentation = props.filterController.displayFilters.show === 'runs';
    const contentContainerStyle = React.useMemo(
        () => [styles.contentContainer, runsPresentation ? null : maxWidthStyle],
        [maxWidthStyle, runsPresentation, styles.contentContainer],
    );
    const safeArea = useChromeSafeAreaInsets();
    const sourceScopeKey = props.filterController.retentionScopeKey;
    const surfaceOwnership = props.surfaceOwnership;
    const showSessionSections = props.corpusStorage === 'active' && props.filterController.displayFilters.show !== 'runs';
    const layout = useSessionListLayoutChoice();
    const surfaceDataActiveRef = React.useRef(surfaceOwnership.dataActive);
    const pageScrollDemandRef = React.useRef(false);
    surfaceDataActiveRef.current = surfaceOwnership.dataActive;
    React.useEffect(() => {
        if (!surfaceOwnership.dataActive) pageScrollDemandRef.current = false;
    }, [surfaceOwnership.dataActive]);
    React.useEffect(() => () => {
        surfaceDataActiveRef.current = false;
    }, []);
    // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
    // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
    // Stopping propagation here keeps the event within the sessions list subtree so native scrolling works.
    // It reads refs only, so the memoized list content keeps one handler for its lifetime.
    const handleStopScrollEventPropagationOnWeb = React.useCallback((event: { stopPropagation?: () => void } | null | undefined) => {
        if (Platform.OS !== 'web') return;
        if (surfaceDataActiveRef.current) pageScrollDemandRef.current = true;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);
    const [refreshingSessions, setRefreshingSessions] = React.useState(false);
    const refreshingSessionsRef = React.useRef(false);
    const viewState = useSessionListViewStateFromPaneState(props.storageKind, props.paneState, props.filterController, {
        pathname: props.pathname,
        surfaceOwnership,
    });
    const scheduledSection = React.useMemo(() => showSessionSections && surfaceOwnership.dataActive
        && props.filterController.viewContext.kind === 'global' ? <ScheduledWorkflowSection density={viewState.rowDensity} /> : undefined,
    [showSessionSections, surfaceOwnership.dataActive, props.filterController.viewContext.kind, viewState.rowDensity]);
    const {
        measureNodeViewportOffset,
        nodeIds,
        onTreeScroll,
        onTreeViewportLayout,
        scrollToIndex,
        scrollToOffset,
    } = viewState;
    const retentionKey = React.useMemo(
        () => buildSessionListViewRetentionKey({
            storageKind: props.storageKind,
            sourceScopeKey,
            viewContextKey: props.filterController.viewContextKey,
            corpusStorage: props.corpusStorage,
        }),
        [props.corpusStorage, props.filterController.viewContextKey, props.storageKind, sourceScopeKey],
    );
    const scrollRetention = useSessionListScrollRetention({
        retentionKey,
        measureNodeViewportOffset,
        nodeIds,
        scrollToIndex,
        scrollToOffset,
        surfaceActive: surfaceOwnership.dataActive,
    });
    const handleLoadMoreSessions = React.useCallback(() => {
        if (!surfaceDataActiveRef.current) return;
        const runWindow = props.paneState.workflowRunWindow;
        if (runWindow?.hasMore && !runWindow.loadingMore) runWindow.loadMore();
        if (props.filterController.displayFilters.show === 'runs') return;
        const query = props.paneState.query;
        fireAndForget(
            query?.active === true ? query.loadNext() : sync.fetchMoreSessions(),
            { tag: query?.active === true ? 'SessionsList.query.loadNext' : 'SessionsList.fetchMoreSessions' },
        );
    }, [props.filterController.displayFilters.show, props.paneState.query, props.paneState.workflowRunWindow]);
    const handleLoadMoreSessionsForViewport = React.useCallback(() => {
        // End callbacks also fire on mount, restoration and content changes.
        // One real scroll interaction can demand one page; programmatic scroll
        // events cannot drain unseen candidates. Explicit Load more stays direct.
        if (!pageScrollDemandRef.current) return;
        pageScrollDemandRef.current = false;
        handleLoadMoreSessions();
    }, [handleLoadMoreSessions]);
    const handleRefreshSessions = React.useCallback(async (retryFailedOperation = false) => {
        if (!surfaceDataActiveRef.current) return;
        if (refreshingSessionsRef.current) return;
        refreshingSessionsRef.current = true;
        setRefreshingSessions(true);
        try {
            const runWindow = props.paneState.workflowRunWindow;
            if (runWindow?.loadMoreFailed) runWindow.loadMore();
            else runWindow?.retry();
            await runRefreshDiagnosticAction(
                { action: 'pull_to_refresh', screen: 'session_list' },
                () => props.filterController.displayFilters.show === 'runs'
                    ? Promise.resolve()
                    : props.paneState.query?.active === true
                        ? retryFailedOperation ? props.paneState.query.retry() : props.paneState.query.refresh()
                        : sync.refreshSessions(),
            );
        } finally {
            refreshingSessionsRef.current = false;
            setRefreshingSessions(false);
        }
    }, [props.filterController.displayFilters.show, props.paneState.query, props.paneState.workflowRunWindow]);
    const handleRetrySessions = React.useCallback(() => handleRefreshSessions(true), [handleRefreshSessions]);
    const handleClearFilters = React.useCallback(() => {
        props.filterController.resetFilters();
    }, [props.filterController]);
    const handleBrowseAllAccessible = React.useCallback(() => {
        props.filterController.updateFilters((current) => ({
            ...current,
            scope: 'all_accessible',
        }));
    }, [props.filterController]);
    const handleShowInactive = React.useCallback(() => {
        props.filterController.setIncludeInactive(true);
    }, [props.filterController]);
    const handleTreeViewportLayout = React.useCallback((event: { nativeEvent?: { layout?: { height?: number } } }) => {
        onTreeViewportLayout(event);
        scrollRetention.handleLayout(event);
    }, [onTreeViewportLayout, scrollRetention]);
    const handleTreeScroll = React.useCallback((event: {
        nativeEvent?: {
            contentOffset?: { y?: number };
            contentSize?: { height?: number };
            layoutMeasurement?: { height?: number };
        };
    }) => {
        if (surfaceDataActiveRef.current) {
            sync.markSessionListScrollActivity();
        }
        scrollRetention.handleScroll(event);
        onTreeScroll(event);
        if (Platform.OS !== 'web' && isSessionListScrollNearEnd(event)) {
            handleLoadMoreSessionsForViewport();
        }
    }, [handleLoadMoreSessionsForViewport, onTreeScroll, scrollRetention]);
    const handleViewableItemsChanged = React.useCallback((info: Parameters<typeof viewState.onViewableItemsChanged>[0]) => {
        scrollRetention.handleViewableItemsChanged(info);
        viewState.onViewableItemsChanged(info);
    }, [scrollRetention, viewState.onViewableItemsChanged]);
    const handleNativeListScrollInteractionStart = React.useCallback(() => {
        scrollRetention.handleScrollInteractionStart();
        viewState.onNativeListScrollInteractionStart();
    }, [scrollRetention, viewState.onNativeListScrollInteractionStart]);
    const handleNativeListUserScrollStart = React.useCallback(() => {
        if (surfaceDataActiveRef.current) pageScrollDemandRef.current = true;
        handleNativeListScrollInteractionStart();
    }, [handleNativeListScrollInteractionStart]);
    const nativeRefreshControl = React.useMemo(() => {
        if (Platform.OS === 'web') return undefined;
        return (
            <RefreshControl
                enabled={surfaceOwnership.dataActive}
                refreshing={surfaceOwnership.dataActive && refreshingSessions}
                onRefresh={surfaceOwnership.dataActive ? handleRefreshSessions : undefined}
            />
        );
    }, [handleRefreshSessions, refreshingSessions, surfaceOwnership.dataActive]);
    const queryVisibleSessionCount = viewState.visibleEntityCount;
    const queryPresentationState = React.useMemo(() => {
        const presentation = props.paneState.queryPresentation;
        if (!presentation) return undefined;
        return {
            presentation,
            visibleSessionCount: queryVisibleSessionCount,
            selectedHomeServerIds: props.filterController.queryHomes.map((home) => home.serverId),
            filters: props.filterController.filters,
            defaults: props.filterController.defaultFilters,
            viewContext: props.filterController.viewContext,
            includeInactive: props.filterController.includeInactive,
            hasHiddenInactiveSessions: props.paneState.hasHiddenInactiveSessions,
            onRetry: handleRetrySessions,
            onLoadMore: handleLoadMoreSessions,
            onClearFilters: handleClearFilters,
            onBrowseAllAccessible: handleBrowseAllAccessible,
            onShowInactive: handleShowInactive,
        };
    }, [
        handleBrowseAllAccessible,
        handleClearFilters,
        handleLoadMoreSessions,
        handleRetrySessions,
        handleShowInactive,
        props.filterController.defaultFilters,
        props.filterController.filters,
        props.filterController.includeInactive,
        props.filterController.queryHomes,
        props.filterController.viewContext,
        props.paneState.queryPresentation,
        props.paneState.query?.active,
        props.paneState.hasHiddenInactiveSessions,
        queryVisibleSessionCount,
    ]);
    const { theme } = useUnistyles();
    const filterChips = React.useMemo(
        () => buildSessionListActiveFilterChips(
            props.filterController,
            <Icon name="tree-structure" size={14} color={theme.colors.text.secondary} />,
        ),
        [props.filterController, theme.colors.text.secondary],
    );
    const filterSummaryLabel = readSessionListWorkFilterSummary(props.filterController);
    const filterSummary = React.useMemo(
        () => filterSummaryLabel
            ? { label: filterSummaryLabel, onReset: props.filterController.resetFilters }
            : undefined,
        [filterSummaryLabel, props.filterController.resetFilters],
    );

    return (
        <SessionSectionDraftContext.Provider value={viewState.sectionDraftController}>
        <SessionListSelectionStoreProvider store={viewState.sessionListSelectionStore}>
        <SessionListOrganizeModeProvider>
        <SessionListStagedMoveProvider handleRowKey={viewState.stagedMove.handleRowKey}>
            <SessionListExternalStatusDemandPublisher {...viewState.externalStatusDemand} />
        <KeyboardAwareScreen
            testID="sessions-list-keyboard-frame"
            mode="form"
            style={styles.container}
            {...(viewState.keyboardZoneProps as Record<string, unknown>)}
        >
            <View
                ref={viewState.treeViewportRef as React.Ref<View>}
                testID="session-list-content"
                onLayout={handleTreeViewportLayout}
                style={contentContainerStyle}
            >
                <SessionListTitleChrome
                    searchChrome={viewState.searchChrome}
                    filterSummary={filterSummary}
                    filterChips={filterChips}
                    presentation={runsPresentation ? 'runs' : 'sessions'}
                />
                {queryVisibleSessionCount > 0 ? (
                    <HomeReachabilityGate
                        variant="line"
                        relevantServerIds={queryPresentationState?.selectedHomeServerIds}
                    >{null}</HomeReachabilityGate>
                ) : null}
                <SyncPerformanceReactProfiler id="sessions.list.virtualized">
                    <SessionListVirtualizedContent
                        listRef={viewState.virtualizedListRef}
                        nodes={viewState.nodes}
                        rowDensity={viewState.rowDensity}
                        rowHeight={viewState.rowHeight}
                        safeAreaBottom={safeArea.bottom}
                        renderItem={viewState.renderVirtualizedItem}
                        rowExtraData={viewState.virtualizedRowExtraData}
                        filteredNoResultsMessage={viewState.filteredNoResultsMessage}
                        queryPresentationState={queryPresentationState}
                        viewContext={props.filterController.viewContext}
                        onScroll={handleTreeScroll}
                        onScrollBeginDrag={handleNativeListUserScrollStart}
                        onScrollEndDrag={viewState.onNativeListScrollInteractionEnd}
                        onMomentumScrollBegin={handleNativeListScrollInteractionStart}
                        onMomentumScrollEnd={viewState.onNativeListScrollInteractionEnd}
                        onEndReached={surfaceOwnership.dataActive ? handleLoadMoreSessionsForViewport : undefined}
                        nativeRefreshControl={nativeRefreshControl}
                        onViewableItemsChanged={handleViewableItemsChanged}
                        viewabilityConfig={viewState.viewabilityConfig}
                        onLayout={handleTreeViewportLayout}
                        onContentSizeChange={viewState.onTreeContentSizeChange}
                        onRegisterTreeRowBounds={viewState.onRegisterTreeRowBounds}
                        onUnregisterTreeRowBounds={viewState.onUnregisterTreeRowBounds}
                        onStopScrollEventPropagationOnWeb={handleStopScrollEventPropagationOnWeb}
                        showDrafts={showSessionSections}
                        showReminders={props.filterController.displayFilters.show !== 'runs'}
                        scheduledSection={scheduledSection}
                        layout={layout}
                    />
                </SyncPerformanceReactProfiler>
                <SessionListDropOverlay
                    shared={viewState.dropOverlayShared}
                    testID="session-list-drop-overlay"
                />
                <SessionListStagedMoveDock runtime={viewState.entityDragDrop.runtime} view={viewState.stagedMove.view} />
                <SessionListSelectionActionBarHost
                    targetsByKey={viewState.sessionListSelectionTargetsByKey}
                    bulkActionContext={viewState.sessionListBulkActionContext}
                    tagsEnabled={viewState.tagsEnabled}
                    onRequestMoveToFolder={viewState.onRequestBulkMoveToFolder}
                />
            </View>
        </KeyboardAwareScreen>
        </SessionListStagedMoveProvider>
        </SessionListOrganizeModeProvider>
        </SessionListSelectionStoreProvider>
        </SessionSectionDraftContext.Provider>
    );
}

/** The list's title row: search chrome normally, the Organize bar while a phone list is organizing. */
const SessionListTitleChrome = React.memo(function SessionListTitleChrome(props: Readonly<{
    searchChrome: React.ComponentProps<typeof SessionListSearchChrome>;
    filterSummary: React.ComponentProps<typeof SessionListSearchChrome>['filterSummary'];
    filterChips: React.ComponentProps<typeof SessionListSearchChrome>['filterChips'];
    presentation: React.ComponentProps<typeof SessionListSearchChrome>['presentation'];
}>) {
    const organize = useSessionListOrganizeMode();
    const sectionDraft = useSessionSectionDraftController();
    if (organize.active) return <SessionListOrganizeBar onDone={organize.exit} onNewSection={sectionDraft?.openNew} />;
    return <SessionListSearchChrome {...props.searchChrome} filterSummary={props.filterSummary} filterChips={props.filterChips} presentation={props.presentation} />;
});
