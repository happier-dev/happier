import React from 'react';
import { View, Platform } from 'react-native';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { sessionListStyles } from './sessionListStyles';
import { SessionListDropOverlay } from './drag/SessionListDropOverlay';
import { SessionListVirtualizedContent } from './sessionListVirtualizedContent';
import { preloadEnrichedMarkdownRuntime } from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { useSessionListViewStateFromPaneState } from './useSessionListViewState';
import { useSessionListScrollRetention } from './scroll/useSessionListScrollRetention';
import { buildSessionListRetentionKey } from './scroll/sessionListRetentionKey';
import { useVisibleSessionListPaneState, type VisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import {
    normalizeSessionListSurfaceOwnership,
    type SessionListSurfaceOwnership,
} from './surface/sessionListSurfaceOwnership';
import { SessionListSelectionStoreProvider } from './selection/SessionListSelectionContext';
import { SessionListSelectionActionBarHost } from './selection/SessionListSelectionActionBar';

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

export function SessionsList(props: Readonly<{
    storageKind?: SessionListStorageFilter;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>) {
    return <SessionsListView {...props} />;
}

export function SessionsListView(props: Readonly<{
    storageKind?: SessionListStorageFilter;
    paneState?: VisibleSessionListPaneState;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>) {
    React.useEffect(() => {
        fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'SessionsList.preloadEnrichedMarkdownRuntime' });
    }, []);

    const storageKind = props.storageKind ?? 'all';
    if (props.paneState) {
        return (
            <SessionsListViewContent
                storageKind={storageKind}
                paneState={props.paneState}
                pathname={props.pathname}
                surfaceOwnership={props.surfaceOwnership}
            />
        );
    }

    return <SessionsListViewWithResolvedPaneState storageKind={storageKind} pathname={props.pathname} surfaceOwnership={props.surfaceOwnership} />;
}

function SessionsListViewWithResolvedPaneState(props: Readonly<{
    storageKind: SessionListStorageFilter;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>) {
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    const paneState = useVisibleSessionListPaneState(props.storageKind, {
        pathname: props.pathname,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
    });
    return (
        <SessionsListViewContent
            storageKind={props.storageKind}
            paneState={paneState}
            pathname={props.pathname}
            surfaceOwnership={surfaceOwnership}
        />
    );
}

function SessionsListViewContent(props: Readonly<{
    storageKind: SessionListStorageFilter;
    paneState: VisibleSessionListPaneState;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>) {
    const styles = sessionListStyles;
    const safeArea = useChromeSafeAreaInsets();
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    const surfaceDataActiveRef = React.useRef(surfaceOwnership.dataActive);
    surfaceDataActiveRef.current = surfaceOwnership.dataActive;
    const viewState = useSessionListViewStateFromPaneState(props.storageKind, props.paneState, {
        pathname: props.pathname,
        surfaceOwnership,
    });
    const {
        onTreeScroll,
        onTreeViewportLayout,
        scrollToOffset,
    } = viewState;
    const retentionKey = React.useMemo(
        () => buildSessionListRetentionKey(props.storageKind),
        [props.storageKind],
    );
    const scrollRetention = useSessionListScrollRetention({
        retentionKey,
        scrollToOffset,
    });
    const handleLoadMoreSessions = React.useCallback(() => {
        if (!surfaceDataActiveRef.current) return;
        fireAndForget(sync.fetchMoreSessions(), { tag: 'SessionsList.fetchMoreSessions' });
    }, []);
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
            handleLoadMoreSessions();
        }
    }, [handleLoadMoreSessions, onTreeScroll, scrollRetention]);

    return (
        <SessionListSelectionStoreProvider store={viewState.sessionListSelectionStore}>
        <View style={styles.container} {...(viewState.keyboardZoneProps as Record<string, unknown>)}>
            <View
                ref={viewState.treeViewportRef as React.Ref<View>}
                onLayout={handleTreeViewportLayout}
                style={styles.contentContainer}
            >
                <SyncPerformanceReactProfiler id="sessions.list.virtualized">
                    <SessionListVirtualizedContent
                        listRef={viewState.virtualizedListRef}
                        nodes={viewState.nodes}
                        rowHeight={viewState.rowHeight}
                        safeAreaBottom={safeArea.bottom}
                        renderItem={viewState.renderVirtualizedItem}
                        rowExtraData={viewState.virtualizedRowExtraData}
                        onScroll={handleTreeScroll}
                        onScrollBeginDrag={viewState.onNativeListScrollInteractionStart}
                        onScrollEndDrag={viewState.onNativeListScrollInteractionEnd}
                        onMomentumScrollBegin={viewState.onNativeListScrollInteractionStart}
                        onMomentumScrollEnd={viewState.onNativeListScrollInteractionEnd}
                        onEndReached={surfaceOwnership.dataActive ? handleLoadMoreSessions : undefined}
                        onViewableItemsChanged={viewState.onViewableItemsChanged}
                        viewabilityConfig={viewState.viewabilityConfig}
                        onLayout={handleTreeViewportLayout}
                        onContentSizeChange={viewState.onTreeContentSizeChange}
                        onStopScrollEventPropagationOnWeb={(event: any) => {
                            // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
                            // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
                            // Stopping propagation here keeps the event within the sessions list subtree so native scrolling works.
                            if (Platform.OS !== 'web') return;
                            if (typeof event?.stopPropagation === 'function') event.stopPropagation();
                        }}
                        onPressArchivedSessions={viewState.onPressArchivedSessions}
                        folderFocus={viewState.folderFocus}
                        folderFocusRootTitle={viewState.folderFocusRootTitle}
                        onClearFolderFocus={viewState.onClearFolderFocus}
                        onSelectFolderBreadcrumb={viewState.onSelectFolderBreadcrumb}
                    />
                </SyncPerformanceReactProfiler>
                <SessionListDropOverlay
                    shared={viewState.dropOverlayShared}
                    testID="session-list-drop-overlay"
                />
                <SessionListSelectionActionBarHost
                    targetsByKey={viewState.sessionListSelectionTargetsByKey}
                    bulkActionContext={viewState.sessionListBulkActionContext}
                    tagsEnabled={viewState.tagsEnabled}
                    onRequestMoveToFolder={viewState.onRequestBulkMoveToFolder}
                />
            </View>
        </View>
        </SessionListSelectionStoreProvider>
    );
}
