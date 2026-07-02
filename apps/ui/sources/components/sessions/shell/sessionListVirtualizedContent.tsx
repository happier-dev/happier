import React from 'react';
import { FlatList, Platform, type ViewToken } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { useSetting } from '@/sync/domains/state/storage';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

import { sessionListStyles } from './sessionListStyles';
import { SessionFolderFocusBreadcrumbs, SessionsListHeader } from './sessionListChrome';
import type { SessionFolderFocusScope } from '@/sync/domains/session/folders';
import type { SessionListRowViewModel } from './sessionListRowViewModels';

export type SessionListVirtualizedNode = Readonly<{
    id: string;
    rowViewModel: SessionListRowViewModel | null;
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
const WEB_LIST_SCROLL_EVENT_THROTTLE_MS = 32;
const NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS = 16;

const sessionListNodeKeyExtractor = (item: SessionListVirtualizedNode): string => item.id;

function getSessionListNodeType(node: SessionListVirtualizedNode): string {
    const nodeId = node.id;
    if (typeof nodeId === 'string' && nodeId.startsWith('session:')) {
        return 'session';
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
                icon={<Ionicons name="archive-outline" size={22} color={theme.colors.text.secondary} />}
                onPress={props.onPress}
            />
        </ItemGroup>
    );
});

export const SessionListVirtualizedContent = React.memo(function SessionListVirtualizedContent(props: Readonly<{
    listRef?: React.Ref<SessionListScrollableRef>;
    nodes: ReadonlyArray<SessionListVirtualizedNode>;
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
    folderFocus: SessionFolderFocusScope | null;
    folderFocusRootTitle?: string | null;
    onClearFolderFocus: () => void;
    onSelectFolderBreadcrumb: (folderId: string) => void;
}>) {
    const contentContainerStyle = React.useMemo(() => ({
        paddingBottom: props.safeAreaBottom + 128,
        maxWidth: layout.maxWidth,
    }), [props.safeAreaBottom]);
    const onPressArchivedSessionsRef = React.useRef(props.onPressArchivedSessions);
    onPressArchivedSessionsRef.current = props.onPressArchivedSessions;
    const handlePressArchivedSessions = React.useCallback(() => {
        onPressArchivedSessionsRef.current();
    }, []);
    const footerComponent = React.useMemo(() => (
        <SessionsListArchivedFooter onPress={handlePressArchivedSessions} />
    ), [handlePressArchivedSessions]);
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

    if (Platform.OS === 'web') {
        const disableWebVirtualization = props.nodes.length <= WEB_LIST_NON_VIRTUALIZED_MAX_ITEMS;
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
                // lists stay windowed so the historical all-rows mount case remains bounded.
                disableVirtualization={disableWebVirtualization}
                initialNumToRender={12}
                maxToRenderPerBatch={8}
                updateCellsBatchingPeriod={50}
                windowSize={3}
                // Keep clipping off on web so drag overlays and lifted rows are not clipped by virtualized cells.
                removeClippedSubviews={false}
            />
        );
    }

    return (
        <FlashList
            ref={props.listRef}
            data={props.nodes as any}
            renderItem={props.renderItem as any}
            extraData={props.rowExtraData}
            keyExtractor={sessionListNodeKeyExtractor}
            getItemType={getSessionListNodeType as any}
            contentContainerStyle={contentContainerStyle as any}
            onScroll={props.onScroll}
            onScrollBeginDrag={props.onScrollBeginDrag}
            onScrollEndDrag={props.onScrollEndDrag}
            onMomentumScrollBegin={props.onMomentumScrollBegin}
            onMomentumScrollEnd={props.onMomentumScrollEnd}
            onEndReached={props.onEndReached}
            onEndReachedThreshold={0.4}
            onViewableItemsChanged={props.onViewableItemsChanged as any}
            viewabilityConfig={props.viewabilityConfig as any}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            scrollEventThrottle={NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS}
            ListHeaderComponent={headerComponent as any}
            ListFooterComponent={footerComponent as any}
        />
    );
});
