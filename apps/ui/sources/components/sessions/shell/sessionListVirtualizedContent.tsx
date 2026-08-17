import React from 'react';
import { FlatList, Platform, View, type ViewToken } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { t, type TranslationKey } from '@/text';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useSetting } from '@/sync/domains/state/storage';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';

import { sessionListStyles } from './sessionListStyles';
import { SessionFolderFocusBreadcrumbs, SessionsListHeader } from './sessionListChrome';
import type { SessionFolderFocusScope } from '@/sync/domains/session/folders';
import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { Icon } from '@/components/ui/icons/Icon';

export type SessionListVirtualizedNode = Readonly<{
    id: string;
    kind?: 'item' | 'filteredNoResults';
    rowViewModel?: SessionListRowViewModel | null;
}>;

type SessionListScrollableRef = Readonly<{
    scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
}>;

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

const WEB_LIST_NON_VIRTUALIZED_MAX_ITEMS = 120;
const WEB_LIST_INITIAL_NUM_TO_RENDER = 12;
const WEB_LIST_MAX_TO_RENDER_PER_BATCH = 8;
const WEB_LIST_UPDATE_CELLS_BATCHING_PERIOD_MS = 50;
const WEB_LIST_WINDOW_SIZE = 3;
const WEB_LIST_SCROLL_EVENT_THROTTLE_MS = 32;
const NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS = 16;

const sessionListNodeKeyExtractor = (item: SessionListVirtualizedNode): string => item.id;

function readSessionListHeaderKindFromNodeId(nodeId: string): string | null {
    if (!nodeId.startsWith('header:')) return null;
    const remaining = nodeId.slice('header:'.length);
    const separatorIndex = remaining.search(/[:|]/);
    return separatorIndex >= 0 ? remaining.slice(0, separatorIndex) : remaining;
}

function isPrioritySessionListHeaderNode(node: SessionListVirtualizedNode): boolean {
    const headerKind = readSessionListHeaderKindFromNodeId(node.id);
    return headerKind === 'attention'
        || headerKind === 'working'
        || headerKind === 'pinned'
        || headerKind === 'active';
}

function isInactiveSessionListHeaderNode(node: SessionListVirtualizedNode): boolean {
    return readSessionListHeaderKindFromNodeId(node.id) === 'inactive';
}

function resolveWebListInitialNumToRender(nodes: ReadonlyArray<SessionListVirtualizedNode>): number {
    if (nodes.length <= WEB_LIST_INITIAL_NUM_TO_RENDER) return WEB_LIST_INITIAL_NUM_TO_RENDER;

    let hasPrioritySection = false;
    let firstInactiveIndex = -1;
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!node) continue;
        if (isPrioritySessionListHeaderNode(node)) {
            hasPrioritySection = true;
        }
        if (isInactiveSessionListHeaderNode(node)) {
            firstInactiveIndex = index;
            break;
        }
    }

    if (!hasPrioritySection) return WEB_LIST_INITIAL_NUM_TO_RENDER;
    const priorityPrefixLength = firstInactiveIndex >= 0 ? firstInactiveIndex : nodes.length;
    return Math.max(WEB_LIST_INITIAL_NUM_TO_RENDER, priorityPrefixLength);
}

export type SessionListRowDensity = 'default' | 'compact' | 'minimal';

/**
 * Virtualized row types are keyed on this value. Session cell heights are
 * NOT uniform: last/single-in-group rows carry the inter-group bottom margin
 * (see SessionItem container styles) and density changes the base height, so
 * pooling all sessions under one type lets a recycled cell reuse a stale
 * height from a different group position — visible as a bottom gap/overlap
 * when sessions change groups. Keying the pool on the HEIGHT CLASS keeps
 * every pool height-homogeneous while avoiding remounts (a type change
 * remounts the cell, tearing down drag/context-menu state) for position
 * flips that do not change the cell height: 'tail' rows (last/single) carry
 * the inter-group gap, 'body' rows (first/middle) do not.
 */
function getSessionListNodeType(node: SessionListVirtualizedNode, rowDensity: SessionListRowDensity): string {
    const nodeId = node.id;
    if (typeof nodeId === 'string' && nodeId.startsWith('session:')) {
        const heightClass = node.rowViewModel?.isLast === true || node.rowViewModel?.isSingle === true
            ? 'tail'
            : 'body';
        return `session:${rowDensity}:${heightClass}`;
    }
    if (typeof nodeId === 'string' && nodeId.startsWith('header:')) {
        const parts = nodeId.split(':');
        const explicit = parts[1] ?? '';
        if (explicit && explicit !== 'server') {
            return `header:${explicit}`;
        }
        if (explicit === 'server' && parts.length <= 3) {
            return 'header:server';
        }
        if (nodeId.includes(':project:')) return 'header:project';
        if (nodeId.includes(':day:') || nodeId.includes(':date:')) return 'header:date';
        if (nodeId.includes(':pinned')) return 'header:pinned';
        if (nodeId.endsWith(':active') || nodeId.includes(':active:')) return 'header:active';
        if (nodeId.endsWith(':inactive') || nodeId.includes(':inactive:')) return 'header:inactive';
    }
    return 'header';
}

const SessionsListArchivedFooter = React.memo(function SessionsListArchivedFooter(props: Readonly<{
    onPress: () => void;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;

    return (
        <ItemGroup style={styles.footerContainer}>
            <Item
                title={hideInactiveSessions
                    ? t('sessionInfo.inactiveAndArchivedSessions')
                    : t('sessionInfo.archivedSessions')}
                icon={<Icon name="archive" size={20} color={theme.colors.text.secondary} />}
                onPress={props.onPress}
            />
        </ItemGroup>
    );
});

export const SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY = 'directSessions.browseNoSearchResults' satisfies TranslationKey;

export function SessionListFilteredNoResultsMessage(props: Readonly<{
    message?: TranslationKey;
}>) {
    return (
        <View
            accessibilityLiveRegion="polite"
            style={sessionListStyles.filteredNoResultsContainer}
            testID="session-list-filtered-no-results"
        >
            <Text style={sessionListStyles.filteredNoResultsText}>
                {t(props.message ?? SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY)}
            </Text>
        </View>
    );
}

export const SessionListVirtualizedContent = React.memo(function SessionListVirtualizedContent(props: Readonly<{
    listRef?: React.Ref<SessionListScrollableRef>;
    nodes: ReadonlyArray<SessionListVirtualizedNode>;
    rowDensity?: SessionListRowDensity;
    rowHeight: number;
    safeAreaBottom: number;
    renderItem: (params: { item: SessionListVirtualizedNode; index: number }) => React.ReactElement | null;
    rowExtraData: unknown;
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
    onPressArchivedSessions: () => void;
    filteredNoResultsMessage?: TranslationKey;
    folderFocus: SessionFolderFocusScope | null;
    folderFocusRootTitle?: string | null;
    onClearFolderFocus: () => void;
    onSelectFolderBreadcrumb: (folderId: string) => void;
}>) {
    // Read reactively and keep it in the memo deps: `layout.maxWidth` alone would be
    // pinned by this memo, so the user's content-width preference would only reach the
    // list after a remount.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const contentContainerStyle = React.useMemo(() => ({
        paddingBottom: props.safeAreaBottom + 128,
        maxWidth: contentMaxWidthStyle.maxWidth,
    }), [contentMaxWidthStyle, props.safeAreaBottom]);
    const onPressArchivedSessionsRef = React.useRef(props.onPressArchivedSessions);
    onPressArchivedSessionsRef.current = props.onPressArchivedSessions;
    const handlePressArchivedSessions = React.useCallback(() => {
        onPressArchivedSessionsRef.current();
    }, []);
    const footerComponent = React.useMemo(() => (
        <>
            {props.filteredNoResultsMessage ? (
                <SessionListFilteredNoResultsMessage message={props.filteredNoResultsMessage} />
            ) : null}
            <SessionsListArchivedFooter onPress={handlePressArchivedSessions} />
        </>
    ), [handlePressArchivedSessions, props.filteredNoResultsMessage]);
    const headerComponent = React.useMemo(() => {
        const folderFocus = props.folderFocus;
        const onClearFolderFocus = props.onClearFolderFocus;
        const onSelectFolderBreadcrumb = props.onSelectFolderBreadcrumb;
        return function SessionListCompositeHeader() {
            return (
                <>
                    <SessionsListHeader />
                    {folderFocus ? (
                        <SessionFolderFocusBreadcrumbs
                            breadcrumbs={folderFocus.breadcrumbs}
                            onClear={onClearFolderFocus}
                            onSelectFolder={onSelectFolderBreadcrumb}
                            rootTitle={props.folderFocusRootTitle}
                        />
                    ) : null}
                </>
            );
        };
    }, [props.folderFocus, props.folderFocusRootTitle, props.onClearFolderFocus, props.onSelectFolderBreadcrumb]);

    const rowDensity: SessionListRowDensity = props.rowDensity ?? 'default';
    const getNodeType = React.useCallback(
        (node: SessionListVirtualizedNode) => getSessionListNodeType(node, rowDensity),
        [rowDensity],
    );
    const isWeb = Platform.OS === 'web';
    const useWebFlatList = isWeb && props.nodes.length <= WEB_LIST_NON_VIRTUALIZED_MAX_ITEMS;
    if (useWebFlatList) {
        const initialNumToRender = resolveWebListInitialNumToRender(props.nodes);
        return (
            <FlatList
                ref={props.listRef}
                {...({
                    onWheel: props.onStopScrollEventPropagationOnWeb,
                    onTouchMove: props.onStopScrollEventPropagationOnWeb,
                } as any)}
                data={props.nodes as any}
                renderItem={props.renderItem as any}
                extraData={props.rowExtraData}
                keyExtractor={sessionListNodeKeyExtractor}
                contentContainerStyle={contentContainerStyle}
                onScroll={props.onScroll}
                onScrollBeginDrag={props.onScrollBeginDrag}
                onScrollEndDrag={props.onScrollEndDrag}
                onMomentumScrollBegin={props.onMomentumScrollBegin}
                onMomentumScrollEnd={props.onMomentumScrollEnd}
                onEndReached={props.onEndReached}
                onEndReachedThreshold={0.4}
                onViewableItemsChanged={props.onViewableItemsChanged}
                viewabilityConfig={props.viewabilityConfig}
                onLayout={props.onLayout}
                onContentSizeChange={props.onContentSizeChange}
                scrollEventThrottle={WEB_LIST_SCROLL_EVENT_THROTTLE_MS}
                ListHeaderComponent={headerComponent as any}
                ListFooterComponent={footerComponent as any}
                // First-page-sized web lists avoid React Native Web VirtualizedList's
                // incremental cell update churn during live row data changes. Large
                // web lists use the canonical virtualized backend below so the historical all-rows
                // mount case remains bounded.
                disableVirtualization={true}
                initialNumToRender={initialNumToRender}
                maxToRenderPerBatch={WEB_LIST_MAX_TO_RENDER_PER_BATCH}
                updateCellsBatchingPeriod={WEB_LIST_UPDATE_CELLS_BATCHING_PERIOD_MS}
                windowSize={WEB_LIST_WINDOW_SIZE}
                // Keep clipping off on web so drag overlays and lifted rows are not clipped by virtualized cells.
                removeClippedSubviews={false}
            />
        );
    }

    return (
        <VirtualizedList
            ref={props.listRef as React.Ref<VirtualizedListRef>}
            backendPreference={isWeb ? 'flat' : 'legend'}
            data={props.nodes as any}
            renderItem={props.renderItem as any}
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
            onViewableItemsChanged={props.onViewableItemsChanged as any}
            viewabilityConfig={props.viewabilityConfig as any}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            scrollEventThrottle={isWeb ? WEB_LIST_SCROLL_EVENT_THROTTLE_MS : NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS}
            ListHeaderComponent={headerComponent as any}
            ListFooterComponent={footerComponent as any}
            // Session rows carry drag state, images, menus, and focus. Keep
            // recycling off until those local-state seams have been audited.
            recycleItems={false}
        />
    );
});
