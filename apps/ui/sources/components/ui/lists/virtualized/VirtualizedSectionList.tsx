import * as React from 'react';
import { SectionList as RNSectionList, type SectionListProps as RNSectionListProps } from 'react-native';
import {
    SectionList as LegendSectionList,
    type SectionListProps as LegendSectionListProps,
    type SectionListRef as LegendSectionListRef,
} from '@legendapp/list/section-list';

import type {
    VirtualizedSectionListProps,
    VirtualizedSectionListRef,
} from './virtualizedListTypes';

/**
 * Canonical section list. `auto` resolves to Legend in dev; React Native's
 * `SectionList` remains an explicit `flat` escape hatch. The imperative handle
 * is the stable {@link VirtualizedSectionListRef}.
 */
function VirtualizedSectionListInner<T>(
    props: VirtualizedSectionListProps<T>,
    ref: React.ForwardedRef<VirtualizedSectionListRef>,
): React.ReactElement {
    const useLegend = props.backendPreference !== 'flat';
    const legendRef = React.useRef<LegendSectionListRef | null>(null);
    const rnRef = React.useRef<RNSectionList<T> | null>(null);

    React.useImperativeHandle(ref, (): VirtualizedSectionListRef => {
        if (useLegend) {
            return {
                scrollToIndex: (params) => legendRef.current?.scrollToIndex(params),
                scrollToOffset: (params) => legendRef.current?.scrollToOffset(params),
                scrollToEnd: (params) => legendRef.current?.scrollToEnd(params),
                scrollToLocation: (params) => legendRef.current?.scrollToLocation(params),
                getScrollableNode: () => legendRef.current?.getScrollableNode(),
                getNativeScrollRef: () => legendRef.current?.getNativeScrollRef(),
                clearMeasurementCache: (options) => legendRef.current?.clearCaches(options),
                getState: () => legendRef.current?.getState(),
            };
        }
        return {
            scrollToIndex: () => {},
            scrollToOffset: (params) => rnRef.current?.getScrollResponder()?.scrollTo({ y: params.offset, animated: params.animated }),
            scrollToLocation: (params) => rnRef.current?.scrollToLocation(params),
            clearMeasurementCache: () => {},
            getState: () => undefined,
        };
    }, [useLegend]);

    const commonProps = {
        sections: props.sections,
        keyExtractor: props.keyExtractor,
        renderItem: props.renderItem,
        renderSectionHeader: props.renderSectionHeader,
        renderSectionFooter: props.renderSectionFooter,
        testID: props.testID,
        nativeID: props.nativeID,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
        ListHeaderComponent: props.ListHeaderComponent,
        ListFooterComponent: props.ListFooterComponent,
        ListEmptyComponent: props.ListEmptyComponent,
        ItemSeparatorComponent: props.ItemSeparatorComponent,
        stickySectionHeadersEnabled: props.stickySectionHeadersEnabled,
        showsVerticalScrollIndicator: props.showsVerticalScrollIndicator,
        scrollEventThrottle: props.scrollEventThrottle,
        onScroll: props.onScroll,
        onLayout: props.onLayout,
        onContentSizeChange: props.onContentSizeChange,
        onEndReached: props.onEndReached,
        onEndReachedThreshold: props.onEndReachedThreshold,
        onViewableItemsChanged: props.onViewableItemsChanged,
        viewabilityConfig: props.viewabilityConfig,
        refreshing: props.refreshing,
        onRefresh: props.onRefresh,
        refreshControl: props.refreshControl,
    };

    if (useLegend) {
        // Boundary adapter: Legend's section shapes are structural supersets of
        // the neutral contract.
        const legendProps = {
            ...commonProps,
            ...props.webScrollHandlers,
            estimatedItemSize: props.estimatedItemSize,
            recycleItems: props.recycleItems,
        } as unknown as LegendSectionListProps<T>;
        return <LegendSectionList {...legendProps} ref={legendRef} />;
    }

    const rnProps = {
        ...commonProps,
        ...props.webScrollHandlers,
    } as unknown as RNSectionListProps<T>;
    return <RNSectionList {...rnProps} ref={rnRef} />;
}

export const VirtualizedSectionList = React.forwardRef(VirtualizedSectionListInner) as <T>(
    props: VirtualizedSectionListProps<T> & { ref?: React.Ref<VirtualizedSectionListRef> },
) => React.ReactElement;
