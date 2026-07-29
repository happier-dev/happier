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

/**
 * Props shared verbatim by every backend. Names come from the FlatList family,
 * which Legend mirrors, so no renaming is needed here.
 */
export type NormalizedSharedListProps<T> = Readonly<{
    data: readonly T[];
    renderItem: VirtualizedListRenderItem<T>;
    keyExtractor: (item: T, index: number) => string;
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
    showsVerticalScrollIndicator?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    scrollEventThrottle?: number;
    onLayout?: VirtualizedListProps<T>['onLayout'];
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
            testID: props.testID,
            nativeID: props.nativeID,
            style: props.style,
            contentContainerStyle: props.contentContainerStyle,
            ListHeaderComponent: props.ListHeaderComponent,
            ListFooterComponent: props.ListFooterComponent,
            ListEmptyComponent: props.ListEmptyComponent,
            ItemSeparatorComponent: props.ItemSeparatorComponent,
            keyboardShouldPersistTaps: props.keyboardShouldPersistTaps,
            keyboardDismissMode: props.keyboardDismissMode,
            showsVerticalScrollIndicator: props.showsVerticalScrollIndicator,
            showsHorizontalScrollIndicator: props.showsHorizontalScrollIndicator,
            scrollEventThrottle: props.scrollEventThrottle,
            onLayout: props.onLayout,
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
            estimatedItemSize: props.estimatedItemSize,
            getItemType: props.getItemType,
            getFixedItemSize: props.getFixedItemSize,
            drawDistance: props.drawDistance,
            recycleItems: props.recycleItems,
            onStartReached: props.onStartReached,
            onStartReachedThreshold: props.onStartReachedThreshold,
        },
    };
}

/**
 * FlatList has no native `onStartReached`; migrated surfaces that need it get
 * the same scroll-offset synthesis the historical compatibility fallback
 * used, so behavior is preserved when `auto` resolves to the flat backend on
 * web.
 */
export function createFlatListStartReachedHandler<T>(
    shared: NormalizedSharedListProps<T>,
    virtualization: NormalizedVirtualizationProps<T>,
    startReachedRef: React.MutableRefObject<boolean>,
): ((event: NativeSyntheticEvent<NativeScrollEvent>) => void) | undefined {
    const { onStartReached } = virtualization;
    if (!onStartReached) {
        return shared.onScroll;
    }
    return (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        shared.onScroll?.(event);
        const thresholdRatio =
            typeof virtualization.onStartReachedThreshold === 'number'
            && Number.isFinite(virtualization.onStartReachedThreshold)
                ? Math.max(0, virtualization.onStartReachedThreshold)
                : 0;
        const thresholdPx = Math.max(1, thresholdRatio * 100);
        const offsetY = event.nativeEvent.contentOffset?.y ?? 0;
        if (offsetY <= thresholdPx) {
            if (!startReachedRef.current) {
                startReachedRef.current = true;
                onStartReached({ distanceFromStart: offsetY });
            }
            return;
        }
        startReachedRef.current = false;
    };
}
