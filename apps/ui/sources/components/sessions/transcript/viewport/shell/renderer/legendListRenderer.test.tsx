import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    resolveMainTranscriptListShellFrame,
    resolveReadOnlyTranscriptListShellFrame,
} from '../transcriptListShellCapabilities';
import type { TranscriptListShellRef } from './types';

let capturedLegendListProps: any = null;
let assignedLegendRef: any = null;
let legendStateOverride: any = null;
let rejectNextScroll = false;

function getShellRef<TItem>(
    ref: React.RefObject<TranscriptListShellRef<TItem> | null>,
): TranscriptListShellRef<TItem> {
    expect(ref.current).not.toBeNull();
    return ref.current!;
}

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: any, ref: any) => {
        capturedLegendListProps = props;
        const makeScrollMethod = () => vi.fn(() => {
            if (rejectNextScroll) {
                rejectNextScroll = false;
                return Promise.reject(new Error('scroll failed'));
            }
            return Promise.resolve();
        });
        const instance = {
            clearCaches: vi.fn(),
            getNativeScrollRef: vi.fn(),
            getScrollableNode: vi.fn(),
            getScrollResponder: vi.fn(),
            getState: vi.fn(() => legendStateOverride ?? ({
                end: Math.max(0, (Array.isArray(props.data) ? props.data.length : 1) - 1),
                positionAtIndex: undefined,
                sizeAtIndex: undefined,
                scroll: 0,
                scrollLength: 0,
                start: 0,
            })),
            scrollToEnd: makeScrollMethod(),
            scrollToIndex: makeScrollMethod(),
            scrollToOffset: makeScrollMethod(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedLegendRef = instance;
        const data = Array.isArray(props.data) ? props.data : [];
        return React.createElement(
            'LegendList',
            props,
            props.ListHeaderComponent ?? null,
            data.map((item: any, index: number) => {
                const type = props.getItemType?.(item, index);
                return React.createElement(
                    'LegendListItem',
                    { key: props.keyExtractor?.(item, index) ?? item.id ?? index },
                    props.renderItem?.({ item, index, type }),
                );
            }),
            props.ListFooterComponent ?? null,
        );
    }),
}));

describe('Legend transcript renderer adapter', () => {
    beforeEach(() => {
        capturedLegendListProps = null;
        assignedLegendRef = null;
        legendStateOverride = null;
        rejectNextScroll = false;
    });

    it('maps the read-only shell seam to the Legend non-inverted chat props', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string; kind: string }>>();
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();
        const onScroll = vi.fn();
        const onScrollBeginDrag = vi.fn();
        const onScrollEndDrag = vi.fn();
        const onMomentumScrollBegin = vi.fn();
        const onMomentumScrollEnd = vi.fn();
        const onStartReached = vi.fn();
        const onEndReached = vi.fn();
        const onWheel = vi.fn();
        const onViewableItemsChanged = vi.fn();
        const viewabilityConfig = { itemVisiblePercentThreshold: 55, minimumViewTime: 120 };

        await renderScreen(
            <Renderer
                ref={listRef}
                data={[
                    { id: 'newest', kind: 'message' },
                    { id: 'oldest', kind: 'message' },
                ]}
                dataKey="session-public-1"
                extraData={2}
                keyExtractor={(item: { id: string }) => item.id}
                getItemType={(item: { kind: string }) => item.kind}
                renderItem={({ item }: { item: { id: string; kind: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveReadOnlyTranscriptListShellFrame({
                    accessKind: 'public',
                    bottomNoticeVisible: false,
                    platformOS: 'ios',
                })}
                header={React.createElement('HeaderSlot')}
                footer={React.createElement('FooterSlot')}
                onLayout={onLayout}
                onContentSizeChange={onContentSizeChange}
                onScroll={onScroll}
                onScrollBeginDrag={onScrollBeginDrag}
                onScrollEndDrag={onScrollEndDrag}
                onMomentumScrollBegin={onMomentumScrollBegin}
                onMomentumScrollEnd={onMomentumScrollEnd}
                onStartReachedThreshold={0.25}
                onStartReached={onStartReached}
                onEndReachedThreshold={0.5}
                onEndReached={onEndReached}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig}
                platformInteractionProps={{ onWheel }}
            />,
        );

        expect(legendListRenderer.kind).toBe('legendList');
        expect(listRef.current).not.toBe(assignedLegendRef);
        expect(capturedLegendListProps).toMatchObject({
            alignItemsAtEnd: true,
            dataKey: 'session-public-1',
            dataVersion: 2,
            estimatedItemSize: 240,
            initialScrollAtEnd: true,
            maintainScrollAtEnd: { animated: false },
            maintainScrollAtEndThreshold: 0.1,
            maintainVisibleContentPosition: { data: true, size: true },
            onLayout,
            onScroll,
            onScrollBeginDrag,
            onScrollEndDrag,
            onMomentumScrollBegin,
            onMomentumScrollEnd,
            onStartReachedThreshold: 0.25,
            onStartReached,
            onEndReachedThreshold: 0.5,
            onEndReached,
            onViewableItemsChanged,
            recycleItems: false,
            viewabilityConfig,
            onWheel,
            scrollEventThrottle: 16,
        });
        expect(capturedLegendListProps.data.map((item: any) => item.id)).toEqual(['oldest', 'newest']);
        // Shell header/footer are FRAME LIST-SPACE slots (FlashList semantics): on a
        // newest-first (native inverted) frame, `header` is the data-start slot, which
        // FlashList renders at the VISUAL BOTTOM. The adapter re-projects data to
        // chronological standard space, so it must re-project the slots the same way:
        // header -> Legend ListFooterComponent (visual bottom), footer -> ListHeaderComponent.
        // Getting this wrong renders the composer keyboard-inset spacer at the TOP of the
        // transcript and the last row flush under the floating composer (native occlusion,
        // live-measured ~130pt on 2026-07-08).
        expect(capturedLegendListProps.ListFooterComponent.type).toBe('HeaderSlot');
        expect(capturedLegendListProps.ListHeaderComponent.type).toBe('FooterSlot');
        expect(capturedLegendListProps).not.toHaveProperty('inverted');
        expect(capturedLegendListProps).not.toHaveProperty('drawDistance');
        // `overrideProps` is FlashList-internal plumbing (styles the internal ScrollView). Its one
        // transcript duty on web — `overflow-anchor: none` (disableBrowserScrollAnchoring) — is
        // discharged by Legend itself: @legendapp/list sets `overflowAnchor: "none"` on its scroll
        // element whenever `maintainVisibleContentPosition` is passed, and this adapter always
        // passes it (asserted above). Forwarding `overrideProps` into Legend would be a silent no-op.
        expect(capturedLegendListProps).not.toHaveProperty('overrideProps');
        expect(capturedLegendListProps).not.toHaveProperty('startRenderingFromBottom');
        // Layout-commit signalling is owned by the LayoutCommitObserver wrapper (see dedicated
        // test below), never by a Legend prop.
        expect(capturedLegendListProps).not.toHaveProperty('onCommitLayoutEffect');
    });

    it('hands Legend initial-scroll ownership on web now that app-side web pin retries are gated', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const onScrollBeginDrag = vi.fn();
        const onScrollEndDrag = vi.fn();
        const onMomentumScrollBegin = vi.fn();

        await renderScreen(
            <Renderer
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onScrollBeginDrag={onScrollBeginDrag}
                onScrollEndDrag={onScrollEndDrag}
                onMomentumScrollBegin={onMomentumScrollBegin}
            />,
        );

        expect(capturedLegendListProps.initialScrollAtEnd).toBe(true);
        // alignItemsAtEnd is layout-only (bottom-hugging padding) and stays on for all platforms.
        expect(capturedLegendListProps.alignItemsAtEnd).toBe(true);
        expect(capturedLegendListProps).not.toHaveProperty('keyboardDismissMode');
        expect(capturedLegendListProps).not.toHaveProperty('keyboardShouldPersistTaps');
        expect(capturedLegendListProps).not.toHaveProperty('onScrollBeginDrag');
        expect(capturedLegendListProps).not.toHaveProperty('onScrollEndDrag');
        expect(capturedLegendListProps).not.toHaveProperty('onMomentumScrollBegin');
    });

    it('keeps edge slots unprojected on oldest-first frames (web standard space)', async () => {
        // On oldest-first frames the shell list-space already IS standard space: header at the
        // visual top, footer (composer inset spacer on main) at the visual bottom. No swap.
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        await renderScreen(
            <Renderer
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                header={React.createElement('HeaderSlot')}
                footer={React.createElement('FooterSlot')}
            />,
        );

        expect(capturedLegendListProps.ListHeaderComponent.type).toBe('HeaderSlot');
        expect(capturedLegendListProps.ListFooterComponent.type).toBe('FooterSlot');
    });

    it('synthesizes the shell onContentSizeChange contract that Legend silently drops', async () => {
        // @legendapp/list has NO onContentSizeChange support (zero occurrences in the 3.x dist).
        // FlashList honored this prop; the whole session-open chain depends on it:
        // onContentSizeChange -> setListContentHeight -> sessionOpenLatch leaves 'awaiting-layout'
        // -> initial fill settles -> older pagination's 'fill-not-done' suspension clears.
        // Without a synthesized signal the latch deadlocks and pagination is permanently dead
        // (live root cause of the C1 regression). The adapter must emit the signal itself from
        // Legend's own state (getState().contentLength) on layout commits and item resizes.
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const onContentSizeChange = vi.fn();

        legendStateOverride = {
            contentLength: 4200,
            end: 0,
            otherAxisSize: 800,
            positionAtIndex: () => 0,
            scroll: 0,
            scrollLength: 600,
            sizeAtIndex: () => 100,
            start: 0,
        };

        await renderScreen(
            <Renderer
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onContentSizeChange={onContentSizeChange}
            />,
        );

        // Initial commit emits the measured content size (width is not part of Legend's
        // public state surface and no transcript consumer reads it — reported as 0).
        expect(onContentSizeChange).toHaveBeenCalledWith(0, 4200);

        // Legend-internal item remeasure (no adapter commit) must also emit.
        legendStateOverride = { ...legendStateOverride, contentLength: 4650 };
        const callsBeforeResize = onContentSizeChange.mock.calls.length;
        capturedLegendListProps.onItemSizeChanged?.({ index: 0, previous: 100, size: 550 });
        expect(onContentSizeChange).toHaveBeenCalledWith(0, 4650);

        // Same size again must dedupe (no spurious re-emissions).
        capturedLegendListProps.onItemSizeChanged?.({ index: 0, previous: 550, size: 550 });
        expect(onContentSizeChange.mock.calls.length).toBe(callsBeforeResize + 1);

        // The raw prop is NOT forwarded to Legend (library ignores it; adapter owns the signal).
        expect(capturedLegendListProps).not.toHaveProperty('onContentSizeChange');
    });

    it('fires the shell onCommitLayoutEffect on layout commits via the LayoutCommitObserver wrapper', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const onCommitLayoutEffect = vi.fn();

        await renderScreen(
            <Renderer
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
                onCommitLayoutEffect={onCommitLayoutEffect}
            />,
        );

        // The viewport ownership stack (recordLayoutCommitObserved) depends on this signal firing
        // for every committed layout pass — silently dropping it starves layout-settle logic.
        expect(onCommitLayoutEffect).toHaveBeenCalled();
    });

    it('contains async Legend ref methods behind the synchronous shell ref contract', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();

        await renderScreen(
            <Renderer
                ref={listRef}
                data={[{ id: 'row-1' }, { id: 'row-2' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveReadOnlyTranscriptListShellFrame({
                    accessKind: 'public',
                    bottomNoticeVisible: false,
                    platformOS: 'web',
                })}
            />,
        );

        const shellRef = getShellRef(listRef);
        expect(shellRef.scrollToIndex?.({ index: 1, animated: false })).toBeUndefined();
        expect(shellRef.scrollToOffset?.({ offset: 120, animated: false })).toBeUndefined();
        expect(shellRef.scrollToEnd?.({ animated: false })).toBeUndefined();
        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({ index: 1, animated: false });
        expect(assignedLegendRef.scrollToOffset).toHaveBeenCalledWith({ offset: 120, animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledWith({ animated: false });
        expect(shellRef.computeVisibleIndices?.()).toEqual({ startIndex: 0, endIndex: 1 });
        expect(shellRef.getAbsoluteLastScrollOffset?.()).toBe(0);
        expect(shellRef.getFirstVisibleIndex?.()).toBe(0);
        expect(shellRef.getLayout?.(1)).toBeUndefined();

        rejectNextScroll = true;
        expect(shellRef.scrollToOffset?.({ offset: 240, animated: false })).toBeUndefined();
        await Promise.resolve();
    });

    it('reports rejected Legend index promises through the shell onScrollToIndexFailed callback', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const onScrollToIndexFailed = vi.fn();

        legendStateOverride = {
            end: 2,
            positionAtIndex: (index: number) => index * 120,
            scroll: 0,
            scrollLength: 360,
            sizeAtIndex: () => 120,
            start: 0,
        };

        await renderScreen(
            <Renderer
                ref={listRef}
                data={[{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'ios',
                })}
                onScrollToIndexFailed={onScrollToIndexFailed}
            />,
        );

        rejectNextScroll = true;
        expect(getShellRef(listRef).scrollToIndex?.({ index: 0, animated: false })).toBeUndefined();
        await Promise.resolve();

        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: false });
        expect(onScrollToIndexFailed).toHaveBeenCalledWith(expect.objectContaining({
            index: 0,
            averageItemLength: 120,
        }));
    });

    it('hosts the shell identity on an adapter-owned wrapper because Legend does not forward it to the DOM', async () => {
        // @legendapp/list 3.3.0 never renders nativeID/testID onto any DOM node (zero
        // occurrences in the dist). On web the entire viewport ownership stack resolves its
        // scroll container from document.getElementById(nativeID) and descends to the
        // scrollable — so the adapter must render the identity on its own wrapper View that
        // is an ancestor of the Legend scroller. Passing identity into LegendList props is a
        // silent no-op and is intentionally NOT done (avoids future duplicate-id risk).
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;

        const screen = await renderScreen(
            <Renderer
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({
                    nativeID: 'legend-main-native-id',
                    platformOS: 'web',
                })}
            />,
        );

        const identityHost = screen.tree.root.findByProps({ nativeID: 'legend-main-native-id' });
        expect(identityHost.props.testID).toBe('transcript-chat-list');
        // The Legend list must render INSIDE the identity host so getElementById(nativeID)
        // followed by scrollable-descendant resolution finds the Legend scroller.
        expect(identityHost.findByType('LegendList' as any)).toBeTruthy();
        // Identity is not passed into Legend props (library ignores it; wrapper owns it).
        expect(capturedLegendListProps.nativeID).toBeUndefined();
        expect(capturedLegendListProps.testID).toBeUndefined();
    });

    it('maps shell source-index commands and visible facts across chronological Legend data', async () => {
        const { legendListRenderer } = await import('./legendListRenderer');
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
        const renderItemCalls: Array<{ id: string; index: number }> = [];
        const getItemTypeCalls: Array<{ id: string; index: number }> = [];

        legendStateOverride = {
            end: 1,
            positionAtIndex: (index: number) => index * 100,
            scroll: 120,
            scrollLength: 300,
            sizeAtIndex: () => 100,
            start: 0,
        };

        await renderScreen(
            <Renderer
                ref={listRef}
                data={[
                    { id: 'newest' },
                    { id: 'middle' },
                    { id: 'oldest' },
                ]}
                keyExtractor={(item: { id: string }) => item.id}
                getItemType={(item: { id: string }, index: number) => {
                    getItemTypeCalls.push({ id: item.id, index });
                    return 'message';
                }}
                renderItem={({ item, index }: { item: { id: string }; index: number }) =>
                {
                    renderItemCalls.push({ id: item.id, index });
                    return React.createElement('Row', { id: item.id, sourceIndex: index });
                }}
                frame={resolveReadOnlyTranscriptListShellFrame({
                    accessKind: 'public',
                    bottomNoticeVisible: false,
                    platformOS: 'ios',
                })}
            />,
        );

        expect(capturedLegendListProps.data.map((item: any) => item.id)).toEqual(['oldest', 'middle', 'newest']);
        expect(getItemTypeCalls).toEqual([
            { id: 'oldest', index: 2 },
            { id: 'middle', index: 1 },
            { id: 'newest', index: 0 },
        ]);
        expect(renderItemCalls).toEqual([
            { id: 'oldest', index: 2 },
            { id: 'middle', index: 1 },
            { id: 'newest', index: 0 },
        ]);
        expect(assignedLegendRef.scrollToIndex).not.toHaveBeenCalled();

        const shellRef = getShellRef(listRef);
        shellRef.scrollToIndex?.({ index: 0, animated: false, viewPosition: 1 });

        expect(assignedLegendRef.scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            animated: false,
            viewPosition: 1,
        });
        expect(shellRef.computeVisibleIndices?.()).toEqual({ startIndex: 1, endIndex: 2 });
        expect(shellRef.getFirstVisibleIndex?.()).toBe(2);
        expect(shellRef.getLayout?.(2)).toEqual({ x: 0, y: 0, width: 0, height: 100 });
        expect(shellRef.getLayout?.(0)).toEqual({ x: 0, y: 200, width: 0, height: 100 });
    });
});
