import React from 'react';
import { Platform, View, type LayoutChangeEvent, type ViewToken } from 'react-native';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t, type TranslationKey } from '@/text';

import { SessionsListHeader } from './sessionListChrome';
import { NewSessionDraftsSection } from './NewSessionDraftsSection';
import { SessionListFirstGroupContext } from './SessionListGroup';
import { SessionListViewEmptyState } from './SessionListViewEmptyState';
import type { SessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import type { SessionListViewContext, SessionListViewFilters } from './search/sessionListViewFilters';
import { SESSION_LIST_SUPPORTING_SECTIONS_NODE, type SessionListVirtualizedNode } from './sessionListVirtualizedNodes';
import { SessionListHeaderFrame, type RegisterSessionListTreeRowBounds, type UnregisterSessionListTreeRowBounds } from './SessionListHeaderFrame';
import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import { hasPendingSessionListLayoutFlight, playSessionListLayoutFlight } from './sessionListLayoutFlight';
export { SESSION_LIST_SUPPORTING_SECTIONS_NODE, type SessionListVirtualizedNode } from './sessionListVirtualizedNodes';

type SessionListScrollEvent = Readonly<{
    nativeEvent?: Readonly<{
        contentOffset?: Readonly<{ y?: number }>;
    }>;
}>;

type SessionListLayoutEvent = Readonly<{
    nativeEvent?: Readonly<{
        layout?: Readonly<{ y?: number; height?: number }>;
    }>;
}>;

const WEB_LIST_SCROLL_EVENT_THROTTLE_MS = 32;
const NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS = 16;
// Row taps must work while the session-search keyboard is open ('handled'), and a
// deliberate list drag dismisses it. Interactive dismissal is iOS-only behaviour.
const SESSION_LIST_KEYBOARD_DISMISS_MODE = Platform.OS === 'ios' ? 'interactive' : 'on-drag';

const sessionListNodeKeyExtractor = (item: SessionListVirtualizedNode): string => item.id;
const ignoreTreeRowBounds = () => {};

type SessionListSupportingSectionsProps = Readonly<{
    rowDensity: SessionListRowDensity;
    showDrafts?: boolean;
    first: boolean;
    scheduledSection?: React.ReactNode;
    viewContext?: SessionListViewContext;
}>;
const SessionListSupportingSectionsContext = React.createContext<SessionListSupportingSectionsProps>({
    rowDensity: 'default', first: false,
});

const SessionListSupportingSections = React.memo(function SessionListSupportingSections() {
    // Legend retains this fixed-key cell when only parent render props change.
    // Transport current slot props here without invalidating any entity cell.
    const props = React.useContext(SessionListSupportingSectionsContext);
    // The column's first group sits just under its header; whichever leading group draws decides it.
    const [scheduledShown, setScheduledShown] = React.useState(false);
    const handleScheduledLayout = React.useCallback((event: LayoutChangeEvent) => {
        const shown = event.nativeEvent.layout.height > 0;
        setScheduledShown((previous) => previous === shown ? previous : shown);
    }, []);
    return (
        <>
            <SessionListFirstGroupContext.Provider value={props.first}>
                <View onLayout={handleScheduledLayout}>{props.scheduledSection}</View>
            </SessionListFirstGroupContext.Provider>
            {props.showDrafts !== false ? (
                <SessionListFirstGroupContext.Provider value={props.first && !scheduledShown}>
                    <NewSessionDraftsSection
                        density={props.rowDensity}
                        viewContext={props.viewContext}
                    />
                </SessionListFirstGroupContext.Provider>
            ) : null}
        </>
    );
});

export const SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY = 'directSessions.browseNoSearchResults' satisfies TranslationKey;

/**
 * The ordinary (non-query) list narrowed by its header filters to nothing: the same one quiet line the
 * query states use, so a search that finds nothing says so instead of leaving bare group headers.
 */
export function SessionListFilteredNoResultsMessage(props: Readonly<{
    message?: TranslationKey;
}>) {
    return (
        <View accessibilityLiveRegion="polite" testID="session-list-filtered-no-results">
            <EmptyState
                layout="line"
                title={t(props.message ?? SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY)}
            />
        </View>
    );
}

export type SessionListRowDensity = 'default' | 'compact' | 'minimal';

/**
 * Layout owns the pool's structural height class on the node. Row-body view
 * models carry content, not adjacency: changing a group boundary must not
 * invalidate an unchanged Session body. Keep the existing tail/body pool
 * names independent of those content subscriptions.
 */
function getSessionListNodeType(node: SessionListVirtualizedNode, rowDensity: SessionListRowDensity): string {
    if (node.kind === 'supporting_sections') return 'supporting_sections';
    if (node.kind === 'workflow_run') {
        return `workflow_run:${rowDensity}:${node.isGroupTail === true ? 'tail' : 'body'}`;
    }
    if (node.kind === 'session') {
        const heightClass = node.isGroupTail === true
            ? 'tail'
            : 'body';
        return `session:${rowDensity}:${heightClass}`;
    }
    if (node.kind === 'header' && node.headerKind) {
        return `header:${node.headerKind}`;
    }
    return 'header';
}

export const SessionListVirtualizedContent = React.memo(function SessionListVirtualizedContent(props: Readonly<{
    listRef?: React.Ref<VirtualizedListRef>;
    nodes: ReadonlyArray<SessionListVirtualizedNode>;
    rowDensity?: SessionListRowDensity;
    rowHeight: number;
    safeAreaBottom: number;
    renderItem: (params: { item: SessionListVirtualizedNode; index: number }) => React.ReactElement | null;
    rowExtraData: unknown;
    onRegisterTreeRowBounds?: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds?: UnregisterSessionListTreeRowBounds;
    onScroll?: (event: SessionListScrollEvent) => void;
    onScrollBeginDrag?: () => void;
    onScrollEndDrag?: () => void;
    onMomentumScrollBegin?: () => void;
    onMomentumScrollEnd?: () => void;
    onEndReached?: () => void;
    nativeRefreshControl?: React.ReactElement;
    onViewableItemsChanged?: (info: { viewableItems: ViewToken[] }) => void;
    viewabilityConfig?: Readonly<{
        itemVisiblePercentThreshold?: number;
        minimumViewTime?: number;
        viewAreaCoveragePercentThreshold?: number;
        waitForInteraction?: boolean;
    }>;
    onLayout?: (event: SessionListLayoutEvent) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onStopScrollEventPropagationOnWeb: (event: any) => void;
    filteredNoResultsMessage?: TranslationKey;
    queryPresentationState?: Readonly<{
        presentation: SessionListQueryPresentation;
        visibleSessionCount: number;
        selectedHomeServerIds?: readonly string[];
        filters: SessionListViewFilters;
        defaults: SessionListViewFilters;
        viewContext: SessionListViewContext;
        includeInactive: boolean;
        hasHiddenInactiveSessions: boolean;
        onRetry: () => void;
        onLoadMore: () => void;
        onClearFilters: () => void;
        onBrowseAllAccessible: () => void;
        onShowInactive: () => void;
    }>;
    /** Qualified corpus context remains available even when no empty/query presentation is mounted. */
    viewContext?: SessionListViewContext;
    showDrafts?: boolean;
    showReminders?: boolean;
    /** The global, live Work sidebar alone demands Account upcoming work. */
    scheduledSection?: React.ReactNode;
    /** The layout these nodes draw; a Projects ↔ Recent choice glides once it commits (web). */
    layout?: SessionListLayoutChoice;
}>) {
    // The SessionsList viewport owns preferred page width versus a filled Run column.
    // Rows fill that viewport; a second cap here would silently narrow only their sheet.
    const contentContainerStyle = React.useMemo(() => ({
        paddingBottom: props.safeAreaBottom + 128,
    }), [props.safeAreaBottom]);
    // A FlatList rejects a new `onViewableItemsChanged` for its whole lifetime ("Changing
    // onViewableItemsChanged on the fly is not supported"), so the list gets one function per list
    // instance that forwards to the caller's current handler. It lives in a ref, not a `useCallback`:
    // Fast Refresh discards hook memo caches on every edit, and a new callback would crash the list.
    const onViewableItemsChangedRef = React.useRef(props.onViewableItemsChanged);
    onViewableItemsChangedRef.current = props.onViewableItemsChanged;
    const viewableItemsChangedForwarderRef = React.useRef<((info: { viewableItems: ViewToken[] }) => void) | null>(null);
    if (viewableItemsChangedForwarderRef.current === null) {
        viewableItemsChangedForwarderRef.current = (info) => {
            onViewableItemsChangedRef.current?.(info);
        };
    }
    const handleViewableItemsChanged = viewableItemsChangedForwarderRef.current;
    // Same lifetime rule for the config (compared deeply): keep the first one this list received.
    const viewabilityConfigRef = React.useRef(props.viewabilityConfig);
    const viewabilityConfig = viewabilityConfigRef.current;
    const rowDensity: SessionListRowDensity = props.rowDensity ?? 'default';
    // Archived is reached from the list title's scope menu, not from a card after the rows.
    const footerComponent = React.useMemo(() => (
        props.queryPresentationState ? (
            <SessionListViewEmptyState {...props.queryPresentationState} />
        ) : props.filteredNoResultsMessage ? (
            <SessionListFilteredNoResultsMessage message={props.filteredNoResultsMessage} />
        ) : null
    ), [props.filteredNoResultsMessage, props.queryPresentationState]);
    // Reminders precede every group; Scheduled/Drafts precede only ordinary groups.
    // Keep the existing measured first-group choice at those actual presentation boundaries.
    const [leadingShown, setLeadingShown] = React.useState({ reminders: false, sections: false });
    const handleLeadingLayout = React.useCallback((event: LayoutChangeEvent) => {
        const shown = event.nativeEvent.layout.height > 0;
        setLeadingShown((previous) => previous.reminders === shown ? previous : { ...previous, reminders: shown });
    }, []);
    const headerComponent = React.useMemo(() => (
        <View onLayout={handleLeadingLayout}>
            {props.showReminders !== false ? <SessionsListHeader /> : null}
        </View>
    ), [handleLeadingLayout, props.showReminders]);
    const handleSupportingLayout = React.useCallback((event: LayoutChangeEvent) => {
        const sections = event.nativeEvent.layout.height > 0;
        setLeadingShown(previous => previous.sections === sections ? previous : { ...previous, sections });
    }, []);
    // One element per registration pair: the cell reads its facts from the context below, so a parent
    // render that changed nothing about the cell must hand Legend the same element and redraw nothing.
    const onRegisterTreeRowBounds = props.onRegisterTreeRowBounds ?? ignoreTreeRowBounds;
    const onUnregisterTreeRowBounds = props.onUnregisterTreeRowBounds ?? ignoreTreeRowBounds;
    const supportingCell = React.useMemo(() => (
        <SessionListHeaderFrame
            treeRowId={SESSION_LIST_SUPPORTING_SECTIONS_NODE.id}
            onRegisterTreeRowBounds={onRegisterTreeRowBounds}
            onUnregisterTreeRowBounds={onUnregisterTreeRowBounds}
            onLayout={handleSupportingLayout}>
            <SessionListSupportingSections />
        </SessionListHeaderFrame>
    ), [handleSupportingLayout, onRegisterTreeRowBounds, onUnregisterTreeRowBounds]);
    const renderItem = (params: { item: SessionListVirtualizedNode; index: number }) => {
        if (params.item.kind === 'supporting_sections') return supportingCell;
        const rendered = props.renderItem(params);
        // Each occurrence carries its node id, which a Session keeps across layouts, for the layout glide.
        const row = Platform.OS === 'web' && rendered
            ? <View {...{ dataSet: { sessionListFlight: params.item.id } }}>{rendered}</View>
            : rendered;
        return params.item.kind === 'header' && params.item.headerKind !== 'attention' && params.item.headerKind !== 'working'
            ? <SessionListFirstGroupContext.Provider value={!leadingShown.reminders && !leadingShown.sections}>
                {row}
            </SessionListFirstGroupContext.Provider>
            : row;
    };
    // As with viewability above, the virtualizer gets one forwarding function
    // for this mounted list, while support-slot and caller facts stay current.
    const currentRenderItemRef = React.useRef(renderItem);
    currentRenderItemRef.current = renderItem;
    const renderItemForwarderRef = React.useRef<typeof renderItem | null>(null);
    if (renderItemForwarderRef.current === null) {
        renderItemForwarderRef.current = (params) => currentRenderItemRef.current(params);
    }
    const getNodeType = React.useCallback(
        (node: SessionListVirtualizedNode) => getSessionListNodeType(node, rowDensity),
        [rowDensity],
    );
    const firstSupportingGroup = props.nodes[0]?.kind === 'supporting_sections' && !leadingShown.reminders;
    const supportingSectionsValue = React.useMemo<SessionListSupportingSectionsProps>(() => ({
        rowDensity, showDrafts: props.showDrafts, scheduledSection: props.scheduledSection,
        viewContext: props.viewContext, first: firstSupportingGroup,
    }), [firstSupportingGroup, props.scheduledSection, props.showDrafts, props.viewContext, rowDensity]);
    const isWeb = Platform.OS === 'web';
    // Plays the captured glide once the nodes of the chosen layout are committed and laid out.
    React.useLayoutEffect(() => {
        if (!isWeb || !props.layout || !hasPendingSessionListLayoutFlight()) return;
        const layout = props.layout;
        const frame = requestAnimationFrame(() => playSessionListLayoutFlight(layout));
        return () => cancelAnimationFrame(frame);
    }, [isWeb, props.layout, props.nodes]);
    return (
        <SessionListSupportingSectionsContext.Provider value={supportingSectionsValue}>
        <SessionListFirstGroupContext.Provider value={!leadingShown.reminders}>
        <VirtualizedList
            ref={props.listRef as React.Ref<VirtualizedListRef>}
            data={props.nodes as any}
            renderItem={renderItemForwarderRef.current}
            extraData={props.rowExtraData}
            keyExtractor={sessionListNodeKeyExtractor}
            getItemType={getNodeType as any}
            contentContainerStyle={contentContainerStyle as any}
            onScroll={props.onScroll}
            onScrollBeginDrag={props.onScrollBeginDrag}
            onScrollEndDrag={props.onScrollEndDrag}
            onMomentumScrollBegin={props.onMomentumScrollBegin}
            onMomentumScrollEnd={props.onMomentumScrollEnd}
            onEndReached={props.onEndReached}
            onEndReachedThreshold={0.4}
            maintainVisibleContentPosition={false}
            refreshControl={isWeb ? undefined : props.nativeRefreshControl}
            webScrollHandlers={isWeb
                ? ({
                    onWheel: props.onStopScrollEventPropagationOnWeb,
                    onTouchMove: props.onStopScrollEventPropagationOnWeb,
                })
                : undefined}
            onViewableItemsChanged={handleViewableItemsChanged as any}
            viewabilityConfig={viewabilityConfig as any}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            scrollEventThrottle={isWeb ? WEB_LIST_SCROLL_EVENT_THROTTLE_MS : NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={SESSION_LIST_KEYBOARD_DISMISS_MODE}
            ListHeaderComponent={headerComponent as any}
            ListFooterComponent={footerComponent as any}
            // Session rows carry drag state, images, menus, and focus. Keep
            // recycling off until those local-state seams have been audited.
            recycleItems={false}
        />
        </SessionListFirstGroupContext.Provider>
        </SessionListSupportingSectionsContext.Provider>
    );
});
