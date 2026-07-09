import * as React from 'react';
import { View } from 'react-native';
import {
    LegendList,
    type LegendListProps,
    type LegendListRef,
    type LegendListState,
} from '@legendapp/list/react-native';

import { LayoutCommitObserver } from '@/components/ui/lists/flashListCompat/FlashListCompat';

import type {
    TranscriptListRenderer,
    TranscriptListRendererProps,
    TranscriptListShellRef,
} from './types';

const LEGEND_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
// The measurement runtime models ordinary transcript rows around 168-240px and
// handles giant markdown rows with per-row measured floors, so this is only a
// first-render hint. It intentionally stays below the giant-row outliers.
const LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX = 240;
// Identity host wrapper: @legendapp/list does not forward nativeID/testID to any
// rendered node (verified against the 3.3.0 dist). The web viewport ownership stack
// resolves its scroll container via document.getElementById(nativeID) and then
// descends to the scrollable, so the adapter must own the identity on a wrapper
// View that is an ancestor of the Legend scroller.
const LEGEND_IDENTITY_HOST_STYLE = { flex: 1, minHeight: 0 } as const;

type ScrollToIndexFailureInfo = Readonly<{
    averageItemLength: number;
    highestMeasuredFrameIndex: number;
    index: number;
}>;

function resolveAverageItemLength(
    state: LegendListState | undefined,
    dataLength: number,
): number {
    if (!state || dataLength <= 0) return 1;
    const scrollLength = typeof state.scrollLength === 'number' && Number.isFinite(state.scrollLength)
        ? state.scrollLength
        : 0;
    if (scrollLength > 0) return Math.max(1, scrollLength / dataLength);
    const visibleCount = Math.max(1, Math.abs(state.end - state.start) + 1);
    let measuredTotal = 0;
    let measuredCount = 0;
    if (typeof state.sizeAtIndex === 'function') {
        const start = Math.max(0, Math.min(state.start, state.end));
        const end = Math.min(dataLength - 1, Math.max(state.start, state.end));
        for (let index = start; index <= end; index += 1) {
            const size = state.sizeAtIndex(index);
            if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
                measuredTotal += size;
                measuredCount += 1;
            }
        }
    }
    if (measuredCount > 0) return Math.max(1, measuredTotal / measuredCount);
    return Math.max(1, scrollLength / visibleCount);
}

function reportScrollToIndexFailed<TItem>(
    onScrollToIndexFailed: TranscriptListRendererProps<TItem>['onScrollToIndexFailed'] | undefined,
    info: ScrollToIndexFailureInfo,
): void {
    if (!onScrollToIndexFailed) return;
    onScrollToIndexFailed(info);
}

function settleLegendScroll(
    promise: Promise<void> | undefined,
    onRejected?: () => void,
): void {
    void promise?.catch(() => {
        onRejected?.();
    });
}

function toLegendData<TItem>(data: readonly TItem[], dataOrder: TranscriptListRendererProps<TItem>['frame']['dataOrder']): readonly TItem[] {
    if (dataOrder === 'newest-first') {
        return [...data].reverse();
    }
    return data;
}

function shouldProjectChronologicalIndex<TItem>(props: TranscriptListRendererProps<TItem>): boolean {
    return props.frame.dataOrder === 'newest-first';
}

function toLegendIndex(sourceIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return sourceIndex;
    return Math.max(0, dataLength - 1 - sourceIndex);
}

function toSourceIndex(legendIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return legendIndex;
    return Math.max(0, dataLength - 1 - legendIndex);
}

function readDataVersion(extraData: unknown): React.Key | undefined {
    return typeof extraData === 'string' || typeof extraData === 'number' ? extraData : undefined;
}

function shouldForwardNativeOnlyLegendProps<TItem>(props: TranscriptListRendererProps<TItem>): boolean {
    return props.frame.rendererOptions.flashList.disableBrowserScrollAnchoring !== true;
}

function toLegendSlot<TItem>(node: React.ReactNode): LegendListProps<TItem>['ListHeaderComponent'] {
    return React.isValidElement(node) ? node : null;
}

function LegendListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const legendListRef = React.useRef<LegendListRef | null>(null);
    const data = React.useMemo(() => toLegendData(props.data, props.frame.dataOrder), [props.data, props.frame.dataOrder]);
    const dataLength = data.length;
    const projectChronologicalIndex = shouldProjectChronologicalIndex(props);

    // @legendapp/list has NO onContentSizeChange support (zero occurrences in the 3.x dist) —
    // forwarding the shell prop is a silent no-op. The session-open chain depends on the signal
    // (onContentSizeChange -> setListContentHeight -> sessionOpenLatch leaves 'awaiting-layout'
    // -> initial fill settles -> older pagination's 'fill-not-done' suspension clears), so the
    // adapter synthesizes it from Legend's own measured state: on every adapter layout commit
    // (data/extraData changes incl. prepends) and on Legend-internal item remeasures
    // (onItemSizeChanged), deduped by the last emitted size.
    const onContentSizeChangeRef = React.useRef(props.onContentSizeChange);
    onContentSizeChangeRef.current = props.onContentSizeChange;
    const lastEmittedContentHeightRef = React.useRef<number | null>(null);
    const emitSynthesizedContentSize = React.useCallback(() => {
        const emit = onContentSizeChangeRef.current;
        if (!emit) return;
        const height = legendListRef.current?.getState().contentLength;
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
        if (lastEmittedContentHeightRef.current === height) return;
        lastEmittedContentHeightRef.current = height;
        // Width is not part of Legend's public state surface and no transcript consumer reads
        // it (the shell handler is `(_, h) => ...`), so the synthesized signal reports 0.
        emit(0, height);
    }, []);

    React.useImperativeHandle(ref, (): TranscriptListShellRef<TItem> => ({
        transcriptViewportCommandSpace: 'standard',
        clearLayoutCacheOnUpdate: () => {
            legendListRef.current?.clearCaches({ mode: 'sizes' });
        },
        computeVisibleIndices: () => {
            const state = legendListRef.current?.getState();
            if (!state) return { startIndex: 0, endIndex: 0 };
            const startIndex = toSourceIndex(state.start, dataLength, projectChronologicalIndex);
            const endIndex = toSourceIndex(state.end, dataLength, projectChronologicalIndex);
            return {
                startIndex: Math.min(startIndex, endIndex),
                endIndex: Math.max(startIndex, endIndex),
            };
        },
        getAbsoluteLastScrollOffset: () => {
            return legendListRef.current?.getState().scroll ?? 0;
        },
        getFirstVisibleIndex: () => {
            const start = legendListRef.current?.getState().start ?? 0;
            return toSourceIndex(start, dataLength, projectChronologicalIndex);
        },
        getLayout: (index) => {
            const state = legendListRef.current?.getState();
            const legendIndex = toLegendIndex(index, dataLength, projectChronologicalIndex);
            const y = state?.positionAtIndex?.(legendIndex);
            const height = state?.sizeAtIndex?.(legendIndex);
            if (typeof y !== 'number' || typeof height !== 'number') return undefined;
            if (!Number.isFinite(y) || !Number.isFinite(height)) return undefined;
            return { x: 0, y, width: 0, height };
        },
        scrollToEnd: (params) => {
            settleLegendScroll(legendListRef.current?.scrollToEnd(params));
        },
        scrollToIndex: (params) => {
            const legendIndex = toLegendIndex(params.index, dataLength, projectChronologicalIndex);
            settleLegendScroll(legendListRef.current?.scrollToIndex({
                ...params,
                index: legendIndex,
            }), () => {
                const state = legendListRef.current?.getState();
                reportScrollToIndexFailed(props.onScrollToIndexFailed, {
                    index: params.index,
                    averageItemLength: resolveAverageItemLength(state, dataLength),
                    highestMeasuredFrameIndex: Math.max(0, dataLength - 1),
                });
            });
        },
        scrollToOffset: (params) => {
            settleLegendScroll(legendListRef.current?.scrollToOffset(params));
        },
    }), [dataLength, projectChronologicalIndex, props.onScrollToIndexFailed]);

    const renderItem: LegendListProps<TItem>['renderItem'] = (info) => props.renderItem({
        item: info.item,
        index: toSourceIndex(info.index, dataLength, projectChronologicalIndex),
        separators: {
            highlight: () => undefined,
            unhighlight: () => undefined,
            updateProps: () => undefined,
        },
    });
    const forwardNativeOnlyLegendProps = shouldForwardNativeOnlyLegendProps(props);

    const legendProps: LegendListProps<TItem> = {
        ...props.platformInteractionProps,
        style: LEGEND_LIST_STYLE,
        alignItemsAtEnd: true,
        data,
        dataKey: props.dataKey,
        dataVersion: readDataVersion(props.extraData),
        estimatedItemSize: LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX,
        extraData: props.extraData,
        getItemType: props.getItemType
            ? (item, index) => {
                const type = props.getItemType?.(
                    item,
                    toSourceIndex(index, dataLength, projectChronologicalIndex),
                    props.extraData,
                );
                return typeof type === 'number' ? String(type) : type;
            }
            : undefined,
        initialScrollAtEnd: true,
        keyExtractor: (item, index) => props.keyExtractor(
            item,
            toSourceIndex(index, dataLength, projectChronologicalIndex),
        ),
        ...(forwardNativeOnlyLegendProps
            ? {
                keyboardDismissMode: props.frame.rendererOptions.flashList.keyboardDismissMode,
                keyboardShouldPersistTaps: props.frame.rendererOptions.flashList.keyboardShouldPersistTaps,
                onMomentumScrollBegin: props.onMomentumScrollBegin,
                onMomentumScrollEnd: props.onMomentumScrollEnd,
                onScrollBeginDrag: props.onScrollBeginDrag,
                onScrollEndDrag: props.onScrollEndDrag,
            }
            : {}),
        // Shell header/footer are FRAME LIST-SPACE slots (FlashList semantics). On newest-first
        // frames FlashList renders inverted, so the shell `header` slot (data-start) appears at
        // the VISUAL BOTTOM — that is where callers put the composer keyboard-inset spacer and
        // hot tail. This adapter re-projects data to chronological standard space, so the slots
        // must be re-projected with it: header -> visual bottom (ListFooterComponent), footer ->
        // visual top (ListHeaderComponent). Without this, the inset spacer renders at the top and
        // the last row lays out under the floating composer (native occlusion, live-measured
        // ~130pt on 2026-07-08). Oldest-first frames already are standard space: no swap.
        ListFooterComponent: toLegendSlot(projectChronologicalIndex ? props.header : props.footer),
        ListHeaderComponent: toLegendSlot(projectChronologicalIndex ? props.footer : props.header),
        maintainScrollAtEnd: { animated: false },
        maintainScrollAtEndThreshold: props.frame.rendererOptions.legend.maintainScrollAtEndThreshold,
        maintainVisibleContentPosition: { data: true, size: true },
        onEndReached: props.onEndReached,
        onEndReachedThreshold: props.onEndReachedThreshold,
        onItemSizeChanged: emitSynthesizedContentSize,
        onLayout: props.onLayout,
        onLoad: (info) => {
            emitSynthesizedContentSize();
            props.onLoad?.(info);
        },
        onScroll: props.onScroll,
        onStartReached: props.onStartReached,
        onStartReachedThreshold: props.onStartReachedThreshold,
        onViewableItemsChanged: props.onViewableItemsChanged,
        // Transcript rows still carry row-local transient UI state (hover/copy/fork affordances)
        // in addition to keyed host expansion state. Keep remount-on-reuse semantics until a
        // recycling-specific row-state audit proves every transient is key-safe.
        recycleItems: false,
        renderItem,
        scrollEventThrottle: props.frame.rendererOptions.flashList.scrollEventThrottle,
        viewabilityConfig: props.viewabilityConfig,
    };

    return (
        <View
            nativeID={props.frame.rendererOptions.flashList.nativeID}
            testID={props.frame.rendererOptions.flashList.testID}
            style={LEGEND_IDENTITY_HOST_STYLE}
        >
            {/* Layout-commit signalling for the viewport ownership stack. FlashList exposes this
                natively via its LayoutCommitObserver; Legend has no equivalent, so the adapter
                reuses the shared observer (falls back to a useLayoutEffect-per-commit shim).
                The same commit signal drives the synthesized onContentSizeChange emission. */}
            <LayoutCommitObserver
                onCommitLayoutEffect={() => {
                    emitSynthesizedContentSize();
                    props.onCommitLayoutEffect?.();
                }}
            >
                <LegendList
                    ref={legendListRef}
                    {...legendProps}
                />
            </LayoutCommitObserver>
        </View>
    );
}

const LegendListTranscriptRenderer = React.forwardRef(LegendListTranscriptRendererInner) as TranscriptListRenderer['Component'];

export const legendListRenderer: TranscriptListRenderer = {
    kind: 'legendList',
    orientation: 'standard',
    Component: LegendListTranscriptRenderer,
};
