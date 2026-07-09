import * as React from 'react';
import type { ViewStyle } from 'react-native';

import {
    FlashList,
    LayoutCommitObserver,
    type FlashListPropsCompat,
    type FlashListRef,
} from '@/components/ui/lists/flashListCompat/FlashListCompat';

import type {
    TranscriptListRenderer,
    TranscriptListRendererProps,
    TranscriptListShellRef,
} from './types';

const FLASH_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
// Browser-native scroll anchoring (overflow-anchor: auto) is a second, invisible
// scrollTop writer on the transcript scroll container: under FlashList window
// reallocation with large rows it re-anchors the viewport to a mid-transcript
// node outside the app's viewport ownership system. The transcript owners must
// be the only anchor authority, so web frames opt the scroller out entirely.
// FlashList applies its `style` prop to an outer wrapper; the real scroll
// container is the internal ScrollView, which only receives `overrideProps`,
// so the opt-out style must ride through overrideProps to reach the scroller.
// (overflowAnchor is a web-only CSS property react-native-web passes through;
// it is not representable in ViewStyle, hence the narrow boundary cast.)
const WEB_SCROLL_ANCHOR_OPT_OUT_STYLE = { overflowAnchor: 'none' } as unknown as ViewStyle;

function resolveScrollerOverrideProps(
    overrideProps: Record<string, unknown> | undefined,
    disableBrowserScrollAnchoring: boolean,
): Record<string, unknown> | undefined {
    if (!disableBrowserScrollAnchoring) return overrideProps;
    return {
        ...overrideProps,
        style: [overrideProps?.style, WEB_SCROLL_ANCHOR_OPT_OUT_STYLE],
    };
}

function FlashListTranscriptRendererInner<TItem>(
    props: TranscriptListRendererProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const flashListOptions = props.frame.rendererOptions.flashList;

    return (
        <LayoutCommitObserver onCommitLayoutEffect={props.onCommitLayoutEffect}>
            <FlashList
                ref={ref as React.ForwardedRef<FlashListRef<TItem>>}
                {...props.platformInteractionProps}
                style={FLASH_LIST_STYLE}
                data={props.data}
                extraData={props.extraData}
                testID={flashListOptions.testID}
                nativeID={flashListOptions.nativeID}
                inverted={flashListOptions.inverted ? true : undefined}
                drawDistance={flashListOptions.drawDistance}
                keyExtractor={props.keyExtractor}
                getItemType={props.getItemType}
                renderItem={props.renderItem}
                overrideProps={resolveScrollerOverrideProps(
                    props.overrideProps,
                    flashListOptions.disableBrowserScrollAnchoring === true,
                )}
                scrollEventThrottle={flashListOptions.scrollEventThrottle}
                keyboardShouldPersistTaps={flashListOptions.keyboardShouldPersistTaps}
                keyboardDismissMode={flashListOptions.keyboardDismissMode}
                happierPauseOffsetCorrection={flashListOptions.pauseOffsetCorrection === true}
                maintainVisibleContentPosition={
                    flashListOptions.maintainVisibleContentPosition as FlashListPropsCompat<TItem>['maintainVisibleContentPosition']
                }
                onLoad={props.onLoad}
                onLayout={props.onLayout}
                onContentSizeChange={props.onContentSizeChange}
                onScroll={props.onScroll}
                onViewableItemsChanged={props.onViewableItemsChanged}
                viewabilityConfig={props.viewabilityConfig}
                onScrollBeginDrag={props.onScrollBeginDrag}
                onScrollEndDrag={props.onScrollEndDrag}
                onMomentumScrollBegin={props.onMomentumScrollBegin}
                onMomentumScrollEnd={props.onMomentumScrollEnd}
                onStartReachedThreshold={props.onStartReachedThreshold}
                onStartReached={props.onStartReached}
                onEndReachedThreshold={props.onEndReachedThreshold}
                onEndReached={props.onEndReached}
                onScrollToIndexFailed={props.onScrollToIndexFailed}
                ListHeaderComponent={props.header ?? null}
                ListFooterComponent={props.footer ?? null}
            />
        </LayoutCommitObserver>
    );
}

const FlashListTranscriptRenderer = React.forwardRef(FlashListTranscriptRendererInner) as TranscriptListRenderer['Component'];

export const flashListRenderer: TranscriptListRenderer = {
    kind: 'flashList',
    orientation: 'frame-resolved',
    Component: FlashListTranscriptRenderer,
};
