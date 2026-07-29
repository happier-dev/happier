import * as React from 'react';
import { FlatList, type FlatListProps } from 'react-native';

import {
    createFlatListStartReachedHandler,
    normalizeVirtualizedListProps,
} from '../normalizeVirtualizedListProps';
import type {
    VirtualizedListProps,
    VirtualizedListRef,
} from '../virtualizedListTypes';

/**
 * React Native `FlatList` backend. Used by `auto` on web and as the universal
 * fallback. FlatList has no measurement cache, so `clearMeasurementCache` is a
 * no-op, and `onStartReached` is synthesized from scroll offset.
 */
function FlatListBackendInner<T>(
    props: VirtualizedListProps<T>,
    ref: React.ForwardedRef<VirtualizedListRef>,
): React.ReactElement {
    const { shared, virtualization } = normalizeVirtualizedListProps(props);
    const innerRef = React.useRef<FlatList<T> | null>(null);
    const startReachedRef = React.useRef(false);

    React.useImperativeHandle(ref, (): VirtualizedListRef => ({
        scrollToIndex: (params) => innerRef.current?.scrollToIndex(params),
        scrollToOffset: (params) => innerRef.current?.scrollToOffset(params),
        scrollToEnd: (params) => innerRef.current?.scrollToEnd(params),
        getScrollableNode: () => innerRef.current?.getScrollableNode?.(),
        getNativeScrollRef: () => innerRef.current?.getNativeScrollRef?.(),
        clearMeasurementCache: () => {},
        getState: () => undefined,
    }), []);

    const onScroll = createFlatListStartReachedHandler(shared, virtualization, startReachedRef);
    const {
        maintainVisibleContentPosition,
        refreshControl,
        webScrollHandlers,
        ...flatShared
    } = shared;
    const flatMaintainVisibleContentPosition =
        maintainVisibleContentPosition
        && typeof maintainVisibleContentPosition === 'object'
        && typeof maintainVisibleContentPosition.minIndexForVisible === 'number'
            ? maintainVisibleContentPosition as FlatListProps<T>['maintainVisibleContentPosition']
            : undefined;

    // Boundary cast: our narrow renderItem info ({ item, index }) is a structural
    // subset of FlatList's ListRenderItemInfo, which also carries `separators`.
    const flatListProps = {
        ...flatShared,
        ...webScrollHandlers,
        maintainVisibleContentPosition: flatMaintainVisibleContentPosition,
        refreshControl: refreshControl as FlatListProps<T>['refreshControl'],
        renderItem: shared.renderItem as unknown as FlatListProps<T>['renderItem'],
        data: shared.data as FlatListProps<T>['data'],
        onScroll,
    } satisfies Partial<FlatListProps<T>> as FlatListProps<T>;

    return <FlatList<T> {...flatListProps} ref={innerRef} />;
}

export const FlatListBackend = React.forwardRef(FlatListBackendInner) as <T>(
    props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef> },
) => React.ReactElement;
