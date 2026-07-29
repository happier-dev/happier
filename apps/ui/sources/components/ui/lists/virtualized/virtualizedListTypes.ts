import type * as React from 'react';
import type {
    NativeScrollEvent,
    NativeSyntheticEvent,
    StyleProp,
    ViewToken,
    ViewStyle,
} from 'react-native';

/**
 * The concrete list runtime a {@link VirtualizedList} resolves to. This is the
 * permanent domain vocabulary: product surfaces never name a specific library,
 * they express intent through {@link VirtualizedListBackendPreference} and the
 * abstraction owns which backend satisfies it.
 */
export type VirtualizedListBackend = 'legend' | 'flat';

/**
 * What a call site asks for. `auto` lets the abstraction pick the current
 * default per platform; the explicit values pin a backend for surfaces that
 * have a proven reason (for example, a known Legend regression that must stay
 * on React Native FlatList).
 */
export type VirtualizedListBackendPreference = 'auto' | VirtualizedListBackend;

/**
 * Stable imperative surface product call sites depend on, independent of the
 * resolved backend. Backends map these onto their native method names in their
 * own adapter (for example, Legend `clearCaches`).
 */
export type VirtualizedListRef = Readonly<{
    scrollToIndex: (params: {
        index: number;
        animated?: boolean;
        viewOffset?: number;
        viewPosition?: number;
    }) => void | Promise<void>;
    scrollToOffset: (params: {
        offset: number;
        animated?: boolean;
    }) => void | Promise<void>;
    scrollToEnd?: (params?: {
        animated?: boolean;
        viewOffset?: number;
    }) => void | Promise<void>;
    getScrollableNode?: () => unknown;
    getNativeScrollRef?: () => unknown;
    clearMeasurementCache?: (options?: { mode?: 'sizes' | 'full' }) => void;
    getState?: () => unknown;
}>;

export type VirtualizedListRenderItemInfo<T> = Readonly<{
    item: T;
    index: number;
}>;

export type VirtualizedListRenderItem<T> = (
    info: VirtualizedListRenderItemInfo<T>,
) => React.ReactElement | null;

/**
 * Narrow, deliberately-curated prop surface shared by every backend. It is a
 * compatibility contract, not a union of every backend's props: backend-only
 * escape hatches are intentionally excluded so call sites cannot couple to one
 * implementation.
 */
export type VirtualizedListProps<T> = Readonly<{
    data: readonly T[] | null | undefined;
    renderItem: VirtualizedListRenderItem<T>;
    keyExtractor: (item: T, index: number) => string;

    backendPreference?: VirtualizedListBackendPreference;

    testID?: string;
    nativeID?: string;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;

    ListHeaderComponent?: React.ComponentType<unknown> | React.ReactElement | null;
    ListFooterComponent?: React.ComponentType<unknown> | React.ReactElement | null;
    ListEmptyComponent?: React.ComponentType<unknown> | React.ReactElement | null;
    ItemSeparatorComponent?: React.ComponentType<unknown> | null;

    keyboardShouldPersistTaps?: 'always' | 'never' | 'handled' | boolean;
    keyboardDismissMode?: 'none' | 'on-drag' | 'interactive';
    showsVerticalScrollIndicator?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    scrollEventThrottle?: number;

    onLayout?: (event: NativeSyntheticEvent<{ layout: { x: number; y: number; width: number; height: number } }>) => void;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onScrollBeginDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onScrollEndDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onMomentumScrollBegin?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onMomentumScrollEnd?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScrollToIndexFailed?: (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => void;
    onViewableItemsChanged?: (info: { viewableItems: ViewToken[]; changed: ViewToken[] }) => void;
    viewabilityConfig?: Readonly<{
        itemVisiblePercentThreshold?: number;
        minimumViewTime?: number;
        viewAreaCoveragePercentThreshold?: number;
        waitForInteraction?: boolean;
    }>;

    onEndReached?: (info?: { distanceFromEnd: number }) => void;
    onEndReachedThreshold?: number;
    onStartReached?: (info?: { distanceFromStart: number }) => void;
    onStartReachedThreshold?: number;

    initialScrollIndex?: number;
    initialNumToRender?: number;
    maxToRenderPerBatch?: number;
    windowSize?: number;
    removeClippedSubviews?: boolean;

    estimatedItemSize?: number;
    getItemType?: (item: T, index: number) => string | number | undefined;
    getItemLayout?: (
        data: ArrayLike<T> | null | undefined,
        index: number,
    ) => { length: number; offset: number; index: number };
    getFixedItemSize?: (item: T, index: number, itemType?: string | number) => number | undefined;
    drawDistance?: number;
    recycleItems?: boolean;
    maintainVisibleContentPosition?: boolean | Readonly<Record<string, unknown>>;

    refreshing?: boolean;
    onRefresh?: () => void;
    refreshControl?: React.ReactElement;

    /**
     * Web-only event handlers applied to the backend's actual scroll owner.
     * Product surfaces use this neutral seam instead of backend-specific
     * `overrideProps`.
     */
    webScrollHandlers?: Readonly<{
        onWheel?: (event: unknown) => void;
        onTouchMove?: (event: unknown) => void;
    }>;

    /**
     * Rerenders every row when it changes. Prefer per-row subscriptions; kept
     * because migrated list surfaces already rely on it.
     */
    extraData?: unknown;
}>;

/**
 * A backend implementation renders one list runtime and exposes the stable
 * {@link VirtualizedListRef}. Backends receive the already-normalized props for
 * their target so they stay thin render + ref-adapter wrappers.
 */
export type VirtualizedListBackendComponent = <T>(
    props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef> },
) => React.ReactElement | null;

export type VirtualizedSection<T> = Readonly<{
    key?: string;
    title?: string;
    data: readonly T[];
}>;

/**
 * Section lists add `scrollToLocation` to the base scroll surface; everything
 * else in {@link VirtualizedListRef} still applies.
 */
export type VirtualizedSectionListRef = VirtualizedListRef & Readonly<{
    scrollToLocation?: (params: {
        sectionIndex: number;
        itemIndex: number;
        animated?: boolean;
        viewOffset?: number;
        viewPosition?: number;
    }) => void | Promise<void>;
}>;

export type VirtualizedSectionListProps<T> = Readonly<{
    sections: readonly VirtualizedSection<T>[];
    renderItem: (info: {
        item: T;
        index: number;
        section: VirtualizedSection<T>;
    }) => React.ReactElement | null;
    keyExtractor: (item: T, index: number) => string;
    renderSectionHeader?: (info: { section: VirtualizedSection<T> }) => React.ReactElement | null;
    renderSectionFooter?: (info: { section: VirtualizedSection<T> }) => React.ReactElement | null;

    backendPreference?: 'auto' | 'legend' | 'flat';

    testID?: string;
    nativeID?: string;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    ListHeaderComponent?: VirtualizedListProps<T>['ListHeaderComponent'];
    ListFooterComponent?: VirtualizedListProps<T>['ListFooterComponent'];
    ListEmptyComponent?: VirtualizedListProps<T>['ListEmptyComponent'];
    ItemSeparatorComponent?: VirtualizedListProps<T>['ItemSeparatorComponent'];
    stickySectionHeadersEnabled?: boolean;
    showsVerticalScrollIndicator?: boolean;
    scrollEventThrottle?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onLayout?: VirtualizedListProps<T>['onLayout'];
    onContentSizeChange?: VirtualizedListProps<T>['onContentSizeChange'];
    onEndReached?: VirtualizedListProps<T>['onEndReached'];
    onEndReachedThreshold?: number;
    onViewableItemsChanged?: VirtualizedListProps<T>['onViewableItemsChanged'];
    viewabilityConfig?: VirtualizedListProps<T>['viewabilityConfig'];
    refreshing?: boolean;
    onRefresh?: () => void;
    refreshControl?: React.ReactElement;
    recycleItems?: boolean;
    webScrollHandlers?: VirtualizedListProps<T>['webScrollHandlers'];
    estimatedItemSize?: number;
}>;
