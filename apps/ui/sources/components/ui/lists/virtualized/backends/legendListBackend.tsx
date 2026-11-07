import * as React from 'react';
import {
    LegendList,
    type LegendListProps,
    type LegendListRef,
} from '@legendapp/list/react-native';
import { Platform, StyleSheet, type ViewStyle } from 'react-native';

import { usePresentedValue } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { normalizeVirtualizedListProps } from '../normalizeVirtualizedListProps';
import type {
    VirtualizedListProps,
    VirtualizedListRef,
    VirtualizedListRenderItemInfo,
} from '../virtualizedListTypes';

const LEGEND_LIST_WEB_FILL_STYLE = {
    flex: 1,
    minHeight: 0,
} as const;

// RN-web's public StyleSheet is also its DOM resolver; React Native's type
// declaration omits that web-only call signature. Flatten first so registered
// styles resolve to inline CSS rather than classes Legend cannot attach here.
const resolveWebStyle = StyleSheet as unknown as (
    style: ViewStyle,
) => readonly [className: string, inlineStyle: React.CSSProperties | undefined];

function resolveLegendWebContentStyle(style: ViewStyle): React.CSSProperties | undefined {
    const inlineStyle = resolveWebStyle(style)[1];
    if (!inlineStyle) return inlineStyle;

    // Legend also reads these CSS dimensions for numeric scroll/item geometry.
    // RN-web emits pixel strings; React DOM accepts equivalent numeric pixels.
    for (const property of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'rowGap', 'columnGap'] as const) {
        const value = inlineStyle[property];
        if (typeof value === 'string' && value.endsWith('px')) {
            const pixels = Number(value.slice(0, -2));
            if (Number.isFinite(pixels)) inlineStyle[property] = pixels;
        }
    }
    // Legend sizes this plain element `min-height: 100%`. Content-box would add the padding on top of
    // the viewport, so a list shorter than its viewport could still scroll by exactly its padding and
    // push its first row under the header. Border-box is what a native ScrollView content container means.
    inlineStyle.boxSizing = 'border-box';
    return inlineStyle;
}

/**
 * Legend List backend — the one list runtime on every platform.
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
        disableVirtualization: _flatListDisableVirtualization,
        nativeID,
        onContentSizeChange,
        onMomentumScrollBegin,
        onScrollEndDrag,
        onScrollToIndexFailed: _flatListOnScrollToIndexFailed,
        removeClippedSubviews: _flatListRemoveClippedSubviews,
        testID,
        windowSize: _flatListWindowSize,
        contentContainerStyle,
        style,
        webScrollHandlers,
        retainedItemKeys,
        ...legendShared
    } = shared;
    const legendContentContainerStyle = React.useMemo(() => (
        Platform.OS === 'web' && contentContainerStyle
            ? resolveLegendWebContentStyle(StyleSheet.flatten(contentContainerStyle))
            : contentContainerStyle
    ), [contentContainerStyle]);
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
    const [focusedItemKey, setFocusedItemKey] = React.useState<string | null>(null);

    React.useImperativeHandle(ref, (): VirtualizedListRef => ({
        scrollToIndex: (params) => innerRef.current?.scrollToIndex(params),
        scrollToOffset: (params) => innerRef.current?.scrollToOffset(params),
        scrollToEnd: (params) => innerRef.current?.scrollToEnd(params),
        getScrollableNode: () => innerRef.current?.getScrollableNode(),
        getNativeScrollRef: () => innerRef.current?.getNativeScrollRef(),
        clearMeasurementCache: (options) => innerRef.current?.clearCaches(options),
        getState: () => innerRef.current?.getState(),
    }), []);

    // The web runtime publishes virtual extents through its state listeners rather than the native
    // ScrollView callback. Adapt that push here so panels and page scrollers consume one size contract.
    // Follow the imperative ref's layout lifecycle: Suspense disconnects it while retaining passive effects.
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || !onContentSizeChange) return;
        const list = innerRef.current;
        if (!list) return;
        const publishSize = () => {
            const node = list.getScrollableNode();
            if (!node) return;
            const length = list.getState().contentLength;
            onContentSizeChange(shared.horizontal ? length : node.clientWidth,
                shared.horizontal ? node.clientHeight : length);
        };
        const state = list.getState();
        const remove = [
            state.listen('totalSize', publishSize),
            state.listen('headerSize', publishSize),
            state.listen('footerSize', publishSize),
            state.listen('otherAxisSize', publishSize),
        ];
        publishSize();
        return () => { for (const unsubscribe of remove) unsubscribe(); };
    }, [onContentSizeChange, shared.horizontal]);

    // A browser retains keyboard focus while a person scrolls. Keep that cell in Legend's
    // existing pinned inventory so recycling cannot silently move focus to the document body.
    const { keyExtractor, renderItem: renderRow } = legendShared;
    const renderWebItem = React.useCallback((info: VirtualizedListRenderItemInfo<T>) => {
        const key = keyExtractor(info.item, info.index);
        return <div style={{ display: 'contents' }} onFocus={() => setFocusedItemKey(key)} onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusedItemKey(null);
        }}>{renderRow(info)}</div>;
    }, [keyExtractor, renderRow]);
    const renderItem = Platform.OS === 'web' ? renderWebItem : renderRow;
    const retainedKeys = focusedItemKey ? [...(retainedItemKeys ?? []), focusedItemKey] : retainedItemKeys;

    // Boundary adapter: Legend's prop and renderItem-info shapes are structural
    // supersets of our neutral contract, mapped in one place here.
    const legendProps = {
        ...legendShared,
        alwaysRender: retainedKeys ? { keys: [...retainedKeys] } : undefined,
        ...platformIdentityAndKeyboardProps,
        ...nativeScrollLifecycleHandlers,
        ...webScrollHandlers,
        contentContainerStyle: legendContentContainerStyle,
        // Legend's web scroll view takes one level of style; a caller's own array must not reach the DOM nested.
        style: Platform.OS === 'web'
            ? StyleSheet.flatten([LEGEND_LIST_WEB_FILL_STYLE, style])
            : style,
        estimatedItemSize: virtualization.estimatedItemSize,
        drawDistance: virtualization.drawDistance,
        getItemType: virtualization.getItemType,
        getFixedItemSize: virtualization.getFixedItemSize,
        getEstimatedItemSize: virtualization.getEstimatedItemSize,
        recycleItems: virtualization.recycleItems,
        onStartReached: virtualization.onStartReached,
        onStartReachedThreshold: virtualization.onStartReachedThreshold,
        renderItem,
        data: legendShared.data,
    } as unknown as LegendListProps<T>;

    // While its retained surface is hidden Legend keeps the last presented props, so a data change there
    // never re-lays out the list against a hidden viewport; current props flow in when it is shown again.
    const presentedLegendProps = usePresentedValue(legendProps);

    return <LegendList {...presentedLegendProps} ref={innerRef} />;
}

export const LegendListBackend = React.forwardRef(LegendListBackendInner) as <T>(
    props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef> },
) => React.ReactElement;
