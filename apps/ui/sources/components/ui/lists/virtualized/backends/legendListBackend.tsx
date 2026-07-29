import * as React from 'react';
import {
    LegendList,
    type LegendListProps,
    type LegendListRef,
} from '@legendapp/list/react-native';
import { Platform } from 'react-native';

import { normalizeVirtualizedListProps } from '../normalizeVirtualizedListProps';
import type {
    VirtualizedListProps,
    VirtualizedListRef,
} from '../virtualizedListTypes';

const LEGEND_LIST_WEB_FILL_STYLE = {
    flex: 1,
    minHeight: 0,
} as const;

/**
 * Legend List backend — the long-term default the abstraction is migrating
 * toward and now the `auto` default on every platform.
 * `clearMeasurementCache` maps to Legend's `clearCaches`; Legend's imperative
 * scroll methods are async (`Promise<void>`), surfaced as-is through the ref.
 */
function LegendListBackendInner<T>(
    props: VirtualizedListProps<T>,
    ref: React.ForwardedRef<VirtualizedListRef>,
): React.ReactElement {
    const { shared, virtualization } = normalizeVirtualizedListProps(props);
    // Legend owns fixed sizing through `getFixedItemSize` and clipping through
    // its recycler. It also forwards unknown web props to its DOM scroll owner,
    // so FlatList-only props are consumed here. Native ScrollView lifecycle
    // handlers remain forwarded on native, where they are valid contracts.
    const {
        getItemLayout: _flatListGetItemLayout,
        initialNumToRender: _flatListInitialNumToRender,
        keyboardShouldPersistTaps,
        keyboardDismissMode,
        maxToRenderPerBatch: _flatListMaxToRenderPerBatch,
        nativeID,
        onContentSizeChange,
        onMomentumScrollBegin,
        onScrollEndDrag,
        onScrollToIndexFailed: _flatListOnScrollToIndexFailed,
        removeClippedSubviews: _flatListRemoveClippedSubviews,
        testID,
        windowSize: _flatListWindowSize,
        style,
        webScrollHandlers,
        ...legendShared
    } = shared;
    const platformIdentityAndKeyboardProps = Platform.OS === 'web'
        ? {
            'data-testid': testID,
            id: nativeID,
        }
        : {
            keyboardShouldPersistTaps,
            nativeID,
            testID,
        };
    const nativeScrollLifecycleHandlers = Platform.OS === 'web'
        ? {}
        : {
            keyboardDismissMode,
            onContentSizeChange,
            onMomentumScrollBegin,
            onScrollEndDrag,
        };
    const innerRef = React.useRef<LegendListRef | null>(null);

    React.useImperativeHandle(ref, (): VirtualizedListRef => ({
        scrollToIndex: (params) => innerRef.current?.scrollToIndex(params),
        scrollToOffset: (params) => innerRef.current?.scrollToOffset(params),
        scrollToEnd: (params) => innerRef.current?.scrollToEnd(params),
        getScrollableNode: () => innerRef.current?.getScrollableNode(),
        getNativeScrollRef: () => innerRef.current?.getNativeScrollRef(),
        clearMeasurementCache: (options) => innerRef.current?.clearCaches(options),
        getState: () => innerRef.current?.getState(),
    }), []);

    // Boundary adapter: Legend's prop and renderItem-info shapes are structural
    // supersets of our neutral contract, mapped in one place here.
    const legendProps = {
        ...legendShared,
        ...platformIdentityAndKeyboardProps,
        ...nativeScrollLifecycleHandlers,
        ...webScrollHandlers,
        style: Platform.OS === 'web'
            ? [LEGEND_LIST_WEB_FILL_STYLE, style]
            : style,
        estimatedItemSize: virtualization.estimatedItemSize,
        drawDistance: virtualization.drawDistance,
        getItemType: virtualization.getItemType,
        getFixedItemSize: virtualization.getFixedItemSize,
        recycleItems: virtualization.recycleItems,
        onStartReached: virtualization.onStartReached,
        onStartReachedThreshold: virtualization.onStartReachedThreshold,
        renderItem: legendShared.renderItem,
        data: legendShared.data,
    } as unknown as LegendListProps<T>;

    return <LegendList {...legendProps} ref={innerRef} />;
}

export const LegendListBackend = React.forwardRef(LegendListBackendInner) as <T>(
    props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef> },
) => React.ReactElement;
