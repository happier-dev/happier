import type * as React from 'react';
import type {
    NativeScrollEvent,
    NativeSyntheticEvent,
    StyleProp,
    ViewStyle,
} from 'react-native';

import type {
    VirtualizedListProps,
    VirtualizedListRenderItem,
} from './virtualizedListTypes';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

/**
 * Props shared verbatim by every backend. Names come from the FlatList family,
 * which Legend mirrors, so no renaming is needed here.
 */
export type NormalizedSharedListProps<T> = Readonly<{
    data: readonly T[];
    renderItem: VirtualizedListRenderItem<T>;
    keyExtractor: (item: T, index: number) => string;
    retainedItemKeys?: readonly string[];
    testID?: string;
    nativeID?: string;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    ListHeaderComponent?: VirtualizedListProps<T>['ListHeaderComponent'];
    ListFooterComponent?: VirtualizedListProps<T>['ListFooterComponent'];
    ListEmptyComponent?: VirtualizedListProps<T>['ListEmptyComponent'];
    ItemSeparatorComponent?: VirtualizedListProps<T>['ItemSeparatorComponent'];
    keyboardShouldPersistTaps?: VirtualizedListProps<T>['keyboardShouldPersistTaps'];
    keyboardDismissMode?: VirtualizedListProps<T>['keyboardDismissMode'];
    horizontal?: boolean;
    showsVerticalScrollIndicator?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    scrollEventThrottle?: number;
    onLayout?: VirtualizedListProps<T>['onLayout'];
    onLoad?: VirtualizedListProps<T>['onLoad'];
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onScrollBeginDrag?: VirtualizedListProps<T>['onScrollBeginDrag'];
    onScrollEndDrag?: VirtualizedListProps<T>['onScrollEndDrag'];
    onMomentumScrollBegin?: VirtualizedListProps<T>['onMomentumScrollBegin'];
    onMomentumScrollEnd?: VirtualizedListProps<T>['onMomentumScrollEnd'];
    onContentSizeChange?: (width: number, height: number) => void;
    onScrollToIndexFailed?: VirtualizedListProps<T>['onScrollToIndexFailed'];
    onViewableItemsChanged?: VirtualizedListProps<T>['onViewableItemsChanged'];
    viewabilityConfig?: VirtualizedListProps<T>['viewabilityConfig'];
    onEndReached?: VirtualizedListProps<T>['onEndReached'];
    onEndReachedThreshold?: number;
    initialScrollIndex?: number;
    initialNumToRender?: number;
    maxToRenderPerBatch?: number;
    disableVirtualization?: boolean;
    windowSize?: number;
    removeClippedSubviews?: boolean;
    getItemLayout?: VirtualizedListProps<T>['getItemLayout'];
    maintainVisibleContentPosition?: VirtualizedListProps<T>['maintainVisibleContentPosition'];
    refreshing?: boolean;
    onRefresh?: () => void;
    refreshControl?: React.ReactElement;
    webScrollHandlers?: VirtualizedListProps<T>['webScrollHandlers'];
    extraData?: unknown;
}>;

/**
 * Virtualization-tuning props that only some backends understand. Backends read
 * the ones they support and ignore the rest, so a caller can pass a single
 * neutral prop set without knowing the resolved backend.
 */
export type NormalizedVirtualizationProps<T> = Readonly<{
    estimatedItemSize?: number;
    getItemType?: (item: T, index: number) => string | number | undefined;
    getFixedItemSize?: VirtualizedListProps<T>['getFixedItemSize'];
    getEstimatedItemSize?: VirtualizedListProps<T>['getEstimatedItemSize'];
    drawDistance?: number;
    recycleItems?: boolean;
    onStartReached?: (info?: { distanceFromStart: number }) => void;
    onStartReachedThreshold?: number;
}>;

export type NormalizedVirtualizedListProps<T> = Readonly<{
    shared: NormalizedSharedListProps<T>;
    virtualization: NormalizedVirtualizationProps<T>;
}>;

/**
 * Single boundary owner that parses the wide {@link VirtualizedListProps} into
 * the props each backend applies. Keeping the split here lets backends stay
 * thin render + ref adapters rather than each re-deriving the mapping.
 */
export function normalizeVirtualizedListProps<T>(
    props: VirtualizedListProps<T>,
): NormalizedVirtualizedListProps<T> {
    return {
        shared: {
            data: props.data ?? [],
            renderItem: props.renderItem,
            keyExtractor: props.keyExtractor,
            retainedItemKeys: props.retainedItemKeys,
            testID: props.testID,
            nativeID: props.nativeID,
            style: props.style,
            contentContainerStyle: props.contentContainerStyle,
            ListHeaderComponent: props.ListHeaderComponent,
            ListFooterComponent: props.ListFooterComponent,
            ListEmptyComponent: props.ListEmptyComponent,
            ItemSeparatorComponent: props.ItemSeparatorComponent,
            keyboardShouldPersistTaps: props.keyboardShouldPersistTaps ?? 'handled',
            keyboardDismissMode: props.keyboardDismissMode,
            horizontal: props.horizontal,
            showsVerticalScrollIndicator: props.showsVerticalScrollIndicator,
            showsHorizontalScrollIndicator: props.showsHorizontalScrollIndicator,
            scrollEventThrottle: props.scrollEventThrottle,
            onLayout: props.onLayout,
            onLoad: props.onLoad,
            onScroll: props.onScroll,
            onScrollBeginDrag: props.onScrollBeginDrag,
            onScrollEndDrag: props.onScrollEndDrag,
            onMomentumScrollBegin: props.onMomentumScrollBegin,
            onMomentumScrollEnd: props.onMomentumScrollEnd,
            onContentSizeChange: props.onContentSizeChange,
            onScrollToIndexFailed: props.onScrollToIndexFailed,
            onViewableItemsChanged: props.onViewableItemsChanged,
            viewabilityConfig: props.viewabilityConfig,
            onEndReached: props.onEndReached,
            onEndReachedThreshold: props.onEndReachedThreshold,
            initialScrollIndex: props.initialScrollIndex,
            initialNumToRender: props.initialNumToRender,
            maxToRenderPerBatch: props.maxToRenderPerBatch,
            disableVirtualization: props.disableVirtualization,
            windowSize: props.windowSize,
            removeClippedSubviews: props.removeClippedSubviews,
            getItemLayout: props.getItemLayout,
            maintainVisibleContentPosition: props.maintainVisibleContentPosition,
            refreshing: props.refreshing,
            onRefresh: props.onRefresh,
            refreshControl: props.refreshControl,
            webScrollHandlers: props.webScrollHandlers,
            extraData: props.extraData,
        },
        virtualization: {
            // Where a backend places a cell it has not measured yet. Legend's own default (100) left arriving
            // rows in tall empty slots until they measured; a list that knows its rows passes their size.
            estimatedItemSize: props.estimatedItemSize ?? HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight,
            getItemType: props.getItemType,
            getFixedItemSize: props.getFixedItemSize,
            getEstimatedItemSize: props.getEstimatedItemSize,
            drawDistance: props.drawDistance,
            recycleItems: props.recycleItems,
            onStartReached: props.onStartReached,
            onStartReachedThreshold: props.onStartReachedThreshold,
        },
    };
}
