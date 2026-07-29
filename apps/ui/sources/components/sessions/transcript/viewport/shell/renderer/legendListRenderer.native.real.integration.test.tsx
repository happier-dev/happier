// @vitest-environment node

import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The SAME specifier the product imports. `vitest.legend-native.config.ts` is the single owner of
// which artifact it resolves to in this lane: it aliases the specifier to the installed native
// ESM build, so both this harness and the renderer adapter under test load the patched native
// runtime through the app's own import mapping — and the lane still fails if that mapping moves.
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';
import type {
    TranscriptListShellRef,
    TranscriptRendererEntryPlacementEvent,
    TranscriptRendererNativePhysicalViewportObservationResult,
} from './types';

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub');
    return {
        ...actual,
        Animated: { ...actual.Animated, ScrollView: 'ScrollView' },
        I18nManager: { isRTL: false },
        Platform: { ...actual.Platform, OS: 'ios' },
        unstable_batchedUpdates: (callback: () => void) => callback(),
    };
});

type Row = Readonly<{ id: string }>;

function createNativeScroller() {
    const nativeScrollHost = {};
    const scroller = {
        flashScrollIndicators: vi.fn(),
        getNativeScrollRef: vi.fn(() => nativeScrollHost),
        getScrollableNode: vi.fn(),
        getScrollResponder: vi.fn(),
        scrollTo: vi.fn(),
        scrollToEnd: vi.fn(),
    };
    scroller.getScrollableNode.mockReturnValue(41);
    scroller.getScrollResponder.mockReturnValue(scroller);
    return scroller;
}

function createNodeMock(nativeScroller: ReturnType<typeof createNativeScroller>) {
    return (element: React.ReactElement) => {
        if (String(element.type) === 'ScrollView') return nativeScroller;
        return {
            measure: (
                callback: (x: number, y: number, width: number, height: number) => void,
            ) => callback(0, 0, 800, 240),
        };
    };
}

function requireMountedScreen(screen: ReactTestRenderer | null): ReactTestRenderer {
    if (!screen) throw new Error('Expected native Legend test renderer to be mounted');
    return screen;
}

async function flushNativeLayouts(currentScreen: ReactTestRenderer): Promise<void> {
    await act(async () => {
        const layoutNodes = currentScreen.root.findAll(
            (node) => typeof node.props.onLayout === 'function',
        );
        for (const node of layoutNodes) {
            node.props.onLayout({
                nativeEvent: { layout: { height: 120, width: 800, x: 0, y: 0 } },
            });
        }
        await Promise.resolve();
    });
}

describe('Legend transcript renderer installed native-package cleanup', () => {
    let screen: ReactTestRenderer | null = null;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 16) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    });

    afterEach(() => {
        if (screen) {
            act(() => screen?.unmount());
            screen = null;
        }
        vi.clearAllTimers();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('does not resurrect a cancelled initial-end handoff after normalized native MVCP data change', async () => {
        type NativeHandoffRow = Readonly<{ height: number; id: string }>;
        const listRef = React.createRef<LegendListRef>();
        const nativeScroller = createNativeScroller();
        let currentRows = Array.from(
            { length: 20 },
            (_value, index): NativeHandoffRow => ({
                height: 120,
                id: `native-handoff-${index}`,
            }),
        );
        let dataVersion = 0;
        let hasMaintainIntent = true;
        const render = () => (
            <LegendList
                data={currentRows}
                dataVersion={dataVersion}
                estimatedItemSize={120}
                estimatedListSize={{ height: 600, width: 800 }}
                getFixedItemSize={(item: NativeHandoffRow) => item.height}
                getItemSizeVersion={(item: NativeHandoffRow) => item.height}
                initialScrollAtEnd
                keyExtractor={(item: NativeHandoffRow) => item.id}
                maintainScrollAtEnd={{
                    animated: false,
                    isMaintainingScrollAtEnd: () => hasMaintainIntent,
                }}
                maintainScrollAtEndThreshold={0.1}
                maintainVisibleContentPosition={{ data: true, size: true }}
                recycleItems={false}
                ref={listRef}
                renderItem={({ item }: { item: NativeHandoffRow }) => (
                    <React.Fragment>{item.id}</React.Fragment>
                )}
            />
        );

        await act(async () => {
            screen = create(render(), { createNodeMock: createNodeMock(nativeScroller) });
        });
        let readyToRender = false;
        const unsubscribeReady = listRef.current!.getState().listen(
            'readyToRender',
            (value) => {
                readyToRender = value;
            },
        );
        await flushNativeLayouts(requireMountedScreen(screen));
        for (let pass = 0; pass < 48 && !readyToRender; pass += 1) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100);
                await Promise.resolve();
            });
            if (!readyToRender) {
                await flushNativeLayouts(requireMountedScreen(screen));
            }
        }
        expect(readyToRender).toBe(true);

        const readNativeEvent = (offsetY: number, contentHeight: number) => ({
            nativeEvent: {
                contentInset: { bottom: 0, left: 0, right: 0, top: 0 },
                contentOffset: { x: 0, y: offsetY },
                contentSize: { height: contentHeight, width: 800 },
                layoutMeasurement: { height: 600, width: 800 },
                zoomScale: 1,
            },
        });
        const scrollView = requireMountedScreen(screen).root.findByType('ScrollView');
        const initialState = listRef.current!.getState();
        const initialEnd = Math.max(0, initialState.contentLength - initialState.scrollLength);
        act(() => {
            scrollView.props.onScroll(readNativeEvent(initialEnd, initialState.contentLength));
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
            await Promise.resolve();
        });

        const scheduledFrames: Array<Readonly<{
            callback: FrameRequestCallback;
            id: number;
            stack: string;
        }>> = [];
        let nextFrameId = 1;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = nextFrameId;
            nextFrameId += 1;
            scheduledFrames.push({
                callback,
                id,
                stack: new Error('scheduled native handoff/MVCP frame').stack ?? '',
            });
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            const index = scheduledFrames.findIndex((frame) => frame.id === id);
            if (index >= 0) scheduledFrames.splice(index, 1);
        });

        // Shrinking rows ahead of the visible end anchor creates a negative normalized
        // data delta while preserving identity, which native MVCP must settle after
        // its physical clamp.
        currentRows = currentRows.map((row, index) => (
            index === currentRows.length - 1 ? row : { ...row, height: 80 }
        ));
        dataVersion += 1;
        await act(async () => {
            requireMountedScreen(screen).update(render());
            await Promise.resolve();
        });
        await flushNativeLayouts(requireMountedScreen(screen));
        const stateBeforeNativeSettle = listRef.current!.getState();
        const prematurelyScheduledMaintainFrames = scheduledFrames.filter(
            (frame) => frame.stack.includes('doMaintainScrollAtEnd'),
        );
        expect(
            prematurelyScheduledMaintainFrames,
            `terminal maintenance must remain deferred behind native MVCP:\n${JSON.stringify({
                contentLength: stateBeforeNativeSettle.contentLength,
                isAtEnd: stateBeforeNativeSettle.isAtEnd,
                scroll: stateBeforeNativeSettle.scroll,
                scrollLength: stateBeforeNativeSettle.scrollLength,
            })}\n${prematurelyScheduledMaintainFrames.map((frame) => frame.stack).join('\n---\n')}`,
        ).toHaveLength(0);

        hasMaintainIntent = false;
        listRef.current!.cancelInitialScrollPreservation();
        const normalizedState = listRef.current!.getState();
        const normalizedEnd = Math.max(
            0,
            normalizedState.contentLength - normalizedState.scrollLength,
        );
        expect(normalizedState.contentLength).toBeLessThan(initialState.contentLength);
        expect(normalizedState.scroll).toBeGreaterThan(normalizedEnd);
        const scrollToWritesBeforeSettle = nativeScroller.scrollTo.mock.calls.length;
        const scrollToEndWritesBeforeSettle = nativeScroller.scrollToEnd.mock.calls.length;
        const updatedScrollView = requireMountedScreen(screen).root.findByType('ScrollView');
        act(() => {
            updatedScrollView.props.onScroll(
                readNativeEvent(normalizedEnd, normalizedState.contentLength),
            );
        });
        const resurrectedMaintainFrames = scheduledFrames.filter(
            (frame) => frame.stack.includes('doMaintainScrollAtEnd'),
        );
        for (let pass = 0; pass < 16 && scheduledFrames.length > 0; pass += 1) {
            const [frame] = scheduledFrames.splice(0, 1);
            await act(async () => {
                frame!.callback(Date.now());
                await vi.advanceTimersByTimeAsync(0);
            });
        }
        const postCancelTailWrites = nativeScroller.scrollTo.mock.calls
            .slice(scrollToWritesBeforeSettle)
            .filter(([params]) => params.y === normalizedEnd);
        const postCancelScrollToEndWrites = nativeScroller.scrollToEnd.mock.calls
            .slice(scrollToEndWritesBeforeSettle);

        expect({
            postCancelScrollToEndWrites,
            postCancelTailWrites,
            resurrectedMaintainFrames: resurrectedMaintainFrames.map((frame) => frame.stack),
        }).toEqual({
            postCancelScrollToEndWrites: [],
            postCancelTailWrites: [],
            resurrectedMaintainFrames: [],
        });
        unsubscribeReady();
    });

    it('cancels native fallback work and settles the pending imperative scroll on unmount', async () => {
        const listRef = React.createRef<LegendListRef>();
        const nativeScroller = createNativeScroller();

        await act(async () => {
            screen = create(
                <LegendList
                    data={Array.from({ length: 10 }, (_value, index) => ({ id: `row-${index}` }))}
                    estimatedItemSize={240}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                { createNodeMock: createNodeMock(nativeScroller) },
            );
        });

        const scrollView = requireMountedScreen(screen).root.findByType('ScrollView');
        act(() => {
            scrollView.props.onLayout({
                nativeEvent: { layout: { height: 600, width: 800, x: 0, y: 0 } },
            });
        });

        let settled = false;
        let result: Promise<void> | undefined;
        act(() => {
            result = listRef.current?.scrollToOffset({ animated: false, offset: 300 });
        });
        void result?.then(() => {
            settled = true;
        });
        expect(nativeScroller.scrollTo).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        act(() => screen?.unmount());
        screen = null;
        await Promise.resolve();

        expect(vi.getTimerCount()).toBe(0);
        expect(settled).toBe(true);
    });

    it('invalidates a not-ready scroll before its readiness frame can write after unmount', async () => {
        const listRef = React.createRef<LegendListRef>();
        const nativeScroller = createNativeScroller();

        await act(async () => {
            screen = create(
                <LegendList
                    data={Array.from({ length: 10 }, (_value, index) => ({ id: `row-${index}` }))}
                    estimatedItemSize={240}
                    keyExtractor={(item: Row) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                { createNodeMock: createNodeMock(nativeScroller) },
            );
        });

        let settled = false;
        let result: Promise<void> | undefined;
        act(() => {
            result = listRef.current?.scrollToIndex({ animated: false, index: 99 });
        });
        void result?.then(() => {
            settled = true;
        });
        const writesBeforeUnmount = nativeScroller.scrollTo.mock.calls.length;
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        act(() => screen?.unmount());
        screen = null;
        await Promise.resolve();
        const timersAfterUnmount = vi.getTimerCount();
        await vi.runAllTimersAsync();

        expect({
            postUnmountWrites: nativeScroller.scrollTo.mock.calls.length - writesBeforeUnmount,
            settled,
            timersAfterUnmount,
        }).toEqual({
            postUnmountWrites: 0,
            settled: true,
            timersAfterUnmount: 0,
        });
    });

    it('commits exclusive keyed ownership to real Legend and restores steady maintenance', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const nativeScroller = createNativeScroller();

        await act(async () => {
            screen = create(
                <Renderer
                    webDomObservation={createWebDomScrollObservation()}
                    data={Array.from({ length: 10 }, (_value, index) => ({ id: `phase-row-${index}` }))}
                    dataKey="native-phase-owner"
                    frame={resolveMainTranscriptListShellFrame({
                        legendInitialScrollAtEnd: true,
                        maintainScrollAtEndThreshold: 0.1,
                        nativeID: 'native-phase-owner',
                        platformOS: 'ios',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                { createNodeMock: createNodeMock(nativeScroller) },
            );
        });

        // Native carries the same semantic predicate as web: Legend evaluates it as an OR
        // against its physical threshold, so it is what keeps follow library-owned once a
        // late measurement pushes the viewport out of the proximity band.
        const initialMaintainConfig = requireMountedScreen(screen)
            .root.findByType(LegendList).props.maintainScrollAtEnd as Readonly<{
                animated: boolean;
                isMaintainingScrollAtEnd: () => boolean;
            }>;
        expect(initialMaintainConfig).toMatchObject({ animated: false });
        expect(initialMaintainConfig.isMaintainingScrollAtEnd()).toBe(true);

        let releaseFirstJump: (() => void) | undefined;
        let releaseSecondJump: (() => void) | undefined;
        act(() => {
            releaseFirstJump = listRef.current?.beginExplicitJumpTakeover?.(Symbol('first-real-jump'));
            releaseSecondJump = listRef.current?.beginExplicitJumpTakeover?.(Symbol('second-real-jump'));
        });
        expect(requireMountedScreen(screen).root.findByType(LegendList).props.maintainScrollAtEnd).toBe(false);
        act(() => releaseFirstJump?.());
        expect(requireMountedScreen(screen).root.findByType(LegendList).props.maintainScrollAtEnd).toBe(false);
        act(() => releaseSecondJump?.());
        expect(requireMountedScreen(screen).root.findByType(LegendList).props.maintainScrollAtEnd).toBe(false);
        act(() => {
            listRef.current?.scrollToIndex?.({ animated: false, index: 5, viewPosition: 0.5 });
        });
        expect(requireMountedScreen(screen).root.findByType(LegendList).props.maintainScrollAtEnd).toBe(false);
        act(() => {
            listRef.current?.scrollToEnd?.({ animated: false });
        });
        expect(requireMountedScreen(screen).root.findByType(LegendList).props.maintainScrollAtEnd)
            .toMatchObject({ animated: false });
    });

    it('publishes native keyed entry placement synchronously and fails open on real drag takeover', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const placementEvents: TranscriptRendererEntryPlacementEvent[] = [];
        const nativeScroller = createNativeScroller();

        await act(async () => {
            screen = create(
                <Renderer
                    webDomObservation={createWebDomScrollObservation()}
                    data={Array.from({ length: 10 }, (_value, index) => ({ id: `entry-row-${index}` }))}
                    dataKey="native-entry-presentation"
                    frame={resolveMainTranscriptListShellFrame({
                        legendInitialScrollAtEnd: false,
                        maintainScrollAtEndThreshold: 0.1,
                        nativeID: 'native-entry-presentation',
                        platformOS: 'ios',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    onEntryPlacementEvent={(event) => placementEvents.push(event)}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                { createNodeMock: createNodeMock(nativeScroller) },
            );
        });

        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                context: {
                    anchor: {
                        itemId: 'entry-row-5',
                        itemOffsetPx: 40,
                        kind: 'item',
                        messageId: null,
                        reason: 'entry-restore',
                    },
                    kind: 'entry-placement',
                },
                index: 5,
                viewOffset: 40,
            });
        });

        expect(placementEvents).toEqual([{
            dataKey: 'native-entry-presentation',
            itemId: 'entry-row-5',
            platform: 'native',
            type: 'started',
        }]);

        act(() => {
            requireMountedScreen(screen).root.findByType(LegendList).props.onScrollBeginDrag({
                nativeEvent: { contentOffset: { x: 0, y: 440 } },
            });
        });

        expect(placementEvents).toEqual([
            {
                dataKey: 'native-entry-presentation',
                itemId: 'entry-row-5',
                platform: 'native',
                type: 'started',
            },
            {
                dataKey: 'native-entry-presentation',
                itemId: 'entry-row-5',
                outcome: 'preempted',
                platform: 'native',
                type: 'finished',
            },
        ]);
    });

    it('settles a native keyed entry from Fabric content coordinates without double-counting scroll', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const placementEvents: TranscriptRendererEntryPlacementEvent[] = [];
        const nativeScroller = createNativeScroller();
        const nativeScrollHost = nativeScroller.getNativeScrollRef() as {
            measure?: (
                callback: (
                    x: number,
                    y: number,
                    width: number,
                    height: number,
                    pageX: number,
                    pageY: number,
                ) => void,
            ) => void;
        };
        const physical = {
            contentTop: 1_200,
            currentOffset: 0,
            hasSemanticLanding: false,
            height: 3_000,
            semanticOffset: 0,
        };
        nativeScrollHost.measure = (callback) => {
            callback(0, 0, 800, 600, 0, 100);
        };
        nativeScroller.scrollTo.mockImplementation((params: Readonly<{ y: number }>) => {
            if (!physical.hasSemanticLanding && params.y > 0) {
                physical.hasSemanticLanding = true;
                physical.semanticOffset = params.y;
            }
            if (physical.hasSemanticLanding) {
                physical.currentOffset = params.y;
            }
        });
        const measureLayout = vi.fn((
            relativeTo: unknown,
            onSuccess: (x: number, y: number, width: number, height: number) => void,
        ) => {
            expect(relativeTo).toBe(nativeScrollHost);
            // RN Fabric measureLayout excludes ScrollView's content offset. The returned
            // y is the row's content-coordinate top and remains fixed as the scroller moves.
            onSuccess(0, physical.contentTop, 800, physical.height);
        });

        await act(async () => {
            screen = create(
                <Renderer
                    webDomObservation={createWebDomScrollObservation()}
                    data={Array.from({ length: 30 }, (_value, index) => ({ id: `physical-entry-row-${index}` }))}
                    dataKey="native-physical-entry-presentation"
                    frame={resolveMainTranscriptListShellFrame({
                        legendInitialScrollAtEnd: false,
                        maintainScrollAtEndThreshold: 0.1,
                        nativeID: 'native-physical-entry-presentation',
                        platformOS: 'ios',
                    })}
                    keyExtractor={(item: Row) => item.id}
                    onEntryPlacementEvent={(event) => placementEvents.push(event)}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
                />,
                {
                    createNodeMock(element: React.ReactElement) {
                        if (String(element.type) === 'ScrollView') return nativeScroller;
                        return {
                            measure: (
                                callback: (
                                    x: number,
                                    y: number,
                                    width: number,
                                    height: number,
                                    pageX: number,
                                    pageY: number,
                                ) => void,
                            ) => callback(
                                0,
                                0,
                                800,
                                physical.height,
                                0,
                                100 + physical.contentTop - physical.currentOffset,
                            ),
                            measureLayout,
                        };
                    },
                },
            );
        });
        await flushNativeLayouts(requireMountedScreen(screen));

        act(() => {
            listRef.current?.scrollToIndex({
                animated: false,
                context: {
                    anchor: {
                        itemId: 'physical-entry-row-10',
                        itemOffsetPx: -1_320.166,
                        kind: 'item',
                        messageId: null,
                        reason: 'entry-restore',
                    },
                    kind: 'entry-placement',
                },
                index: 10,
                viewOffset: -1_320.166,
            });
        });
        expect(placementEvents).toEqual([{
            dataKey: 'native-physical-entry-presentation',
            itemId: 'physical-entry-row-10',
            platform: 'native',
            type: 'started',
        }]);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_000);
        });

        expect(measureLayout).toHaveBeenCalled();
        expect(physical.semanticOffset).toBeGreaterThan(0);
        expect(physical.currentOffset).toBeCloseTo(2_520.166);
        expect(physical.contentTop - physical.currentOffset).toBeCloseTo(-1_320.166);
        expect(placementEvents).toHaveLength(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_000);
        });

        expect(placementEvents).toEqual([
            {
                dataKey: 'native-physical-entry-presentation',
                itemId: 'physical-entry-row-10',
                platform: 'native',
                type: 'started',
            },
            {
                dataKey: 'native-physical-entry-presentation',
                itemId: 'physical-entry-row-10',
                outcome: 'settled',
                platform: 'native',
                type: 'finished',
            },
        ]);
    });

    it('captures source-order identity and bottom distance from one installed-native physical observation', async () => {
        const Renderer = legendListRenderer.Component;
        const listRef = React.createRef<TranscriptListShellRef<Row>>();
        const contentHost = {
            measure: (callback: (
                x: number,
                y: number,
                width: number,
                height: number,
                pageX: number,
                pageY: number,
            ) => void) => callback(0, 0, 800, 4_000, 0, -1_000),
        };
        const scrollHost = {
            measure: (callback: (
                x: number,
                y: number,
                width: number,
                height: number,
                pageX: number,
                pageY: number,
            ) => void) => callback(0, 0, 800, 600, 0, 100),
        };
        const nativeScroller = {
            ...createNativeScroller(),
            getInnerViewRef: vi.fn(() => contentHost),
            getNativeScrollRef: vi.fn(() => scrollHost),
        };
        let deferPhysicalMeasurements = false;
        const pendingMeasurements: Array<() => void> = [];
        const createMeasuredNode = () => ({
            measure: (callback: (
                x: number,
                y: number,
                width: number,
                height: number,
                pageX: number,
                pageY: number,
            ) => void) => {
                const complete = () => callback(0, 0, 800, 240, 0, 150);
                if (deferPhysicalMeasurements) pendingMeasurements.push(complete);
                else complete();
            },
        });
        const rows = [
            { id: 'newest' },
            { id: 'middle' },
            { id: 'oldest' },
        ];
        const render = (dataKey: string, data: readonly Row[]) => (
            <Renderer
                webDomObservation={createWebDomScrollObservation()}
                data={data}
                dataKey={dataKey}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: dataKey,
                    platformOS: 'ios',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={listRef}
                renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
            />
        );

        await act(async () => {
            screen = create(render('physical-capture-a', rows), {
                createNodeMock(element: React.ReactElement) {
                    if (String(element.type) === 'ScrollView') return nativeScroller;
                    return createMeasuredNode();
                },
            });
        });
        await flushNativeLayouts(requireMountedScreen(screen));

        const onComplete = vi.fn();
        let observationResult: TranscriptRendererNativePhysicalViewportObservationResult | undefined;
        act(() => {
            observationResult = listRef.current?.observeNativePhysicalViewport?.({
                focusOffsetPx: 108,
                onComplete,
            });
        });

        expect(observationResult!).toEqual({ status: 'pending' });
        expect(onComplete).toHaveBeenCalledExactlyOnceWith({
            capturedAtMs: expect.any(Number),
            dataKey: 'physical-capture-a',
            itemIndex: 2,
            itemKey: 'oldest',
            itemOffsetPx: 50,
            offsetY: 2_300,
        });
        expect(listRef.current?.observeNativePhysicalViewport?.({ focusOffsetPx: 108 })).toEqual({
            capture: expect.objectContaining({
                dataKey: 'physical-capture-a',
                itemIndex: 2,
                itemKey: 'oldest',
                itemOffsetPx: 50,
                offsetY: 2_300,
            }),
            status: 'captured',
        });

        await act(async () => {
            requireMountedScreen(screen).update(render('physical-capture-b', rows));
        });
        expect(listRef.current?.observeNativePhysicalViewport?.({ focusOffsetPx: 108 }))
            .toEqual({ status: 'unavailable' });

        deferPhysicalMeasurements = true;
        const staleCompletion = vi.fn();
        act(() => {
            expect(listRef.current?.observeNativePhysicalViewport?.({
                focusOffsetPx: 108,
                onComplete: staleCompletion,
            })).toEqual({ status: 'pending' });
        });
        await act(async () => {
            requireMountedScreen(screen).update(render('physical-capture-c', rows));
        });
        act(() => pendingMeasurements.splice(0).forEach((complete) => complete()));

        expect(staleCompletion).not.toHaveBeenCalled();
    });

    it('drops an installed-native physical observation completed after the renderer remounts', async () => {
        const Renderer = legendListRenderer.Component;
        const firstListRef = React.createRef<TranscriptListShellRef<Row>>();
        const secondListRef = React.createRef<TranscriptListShellRef<Row>>();
        const pendingMeasurements: Array<() => void> = [];
        let deferPhysicalMeasurements = false;
        const contentHost = {
            measure: (callback: (
                x: number,
                y: number,
                width: number,
                height: number,
                pageX: number,
                pageY: number,
            ) => void) => {
                const complete = () => callback(0, 0, 800, 4_000, 0, -1_000);
                if (deferPhysicalMeasurements) pendingMeasurements.push(complete);
                else complete();
            },
        };
        const scrollHost = {
            measure: (callback: (
                x: number,
                y: number,
                width: number,
                height: number,
                pageX: number,
                pageY: number,
            ) => void) => {
                const complete = () => callback(0, 0, 800, 600, 0, 100);
                if (deferPhysicalMeasurements) pendingMeasurements.push(complete);
                else complete();
            },
        };
        const nativeScroller = {
            ...createNativeScroller(),
            getInnerViewRef: vi.fn(() => contentHost),
            getNativeScrollRef: vi.fn(() => scrollHost),
        };
        const createMeasuredNode = () => ({
            measure: (callback: (
                x: number,
                y: number,
                width: number,
                height: number,
                pageX: number,
                pageY: number,
            ) => void) => {
                const complete = () => callback(0, 0, 800, 240, 0, 150);
                if (deferPhysicalMeasurements) pendingMeasurements.push(complete);
                else complete();
            },
        });
        const render = (dataKey: string, ref: React.RefObject<TranscriptListShellRef<Row> | null>) => (
            <Renderer
                webDomObservation={createWebDomScrollObservation()}
                data={[{ id: 'newest' }, { id: 'oldest' }]}
                dataKey={dataKey}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: false,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: dataKey,
                    platformOS: 'ios',
                })}
                keyExtractor={(item: Row) => item.id}
                ref={ref}
                renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
            />
        );
        const createOptions = {
            createNodeMock(element: React.ReactElement) {
                if (String(element.type) === 'ScrollView') return nativeScroller;
                return createMeasuredNode();
            },
        };

        await act(async () => {
            screen = create(render('physical-remount-a', firstListRef), createOptions);
        });
        await flushNativeLayouts(requireMountedScreen(screen));
        deferPhysicalMeasurements = true;
        const staleCompletion = vi.fn();
        act(() => {
            expect(firstListRef.current?.observeNativePhysicalViewport?.({
                focusOffsetPx: 108,
                onComplete: staleCompletion,
            })).toEqual({ status: 'pending' });
        });

        act(() => screen?.unmount());
        screen = null;
        deferPhysicalMeasurements = false;
        await act(async () => {
            screen = create(render('physical-remount-b', secondListRef), createOptions);
        });
        await flushNativeLayouts(requireMountedScreen(screen));
        act(() => pendingMeasurements.splice(0).forEach((complete) => complete()));

        expect(staleCompletion).not.toHaveBeenCalled();
        expect(secondListRef.current?.observeNativePhysicalViewport?.({ focusOffsetPx: 108 }))
            .toEqual({ status: 'unavailable' });
    });
});

describe('Legend transcript renderer installed native-package end follow (E-18)', () => {
    const ROW_TEST_ID_PREFIX = 'e18-row:';
    const VIEWPORT_HEIGHT = 120;
    let screen: ReactTestRenderer | null = null;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 16) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    });

    afterEach(() => {
        if (screen) {
            act(() => screen?.unmount());
            screen = null;
        }
        vi.clearAllTimers();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    /**
     * Emit one native layout pass. Legend attaches `onLayout` to its own per-item containers
     * as well as to enclosing views, so a container that wraps exactly one transcript row is
     * measured with that row's height and everything else keeps the viewport height.
     */
    async function flushRowLayouts(
        mounted: ReactTestRenderer,
        resolveRowHeight: (rowId: string) => number,
    ): Promise<void> {
        await act(async () => {
            const layoutNodes = mounted.root.findAll(
                (node) => typeof node.props.onLayout === 'function',
            );
            for (const node of layoutNodes) {
                const rowIds = node
                    .findAll(
                        (candidate) => typeof candidate.props?.testID === 'string'
                            && candidate.props.testID.startsWith(ROW_TEST_ID_PREFIX),
                        { deep: true },
                    )
                    .map((candidate) => String(candidate.props.testID));
                const height = rowIds.length === 1
                    ? resolveRowHeight(rowIds[0]!)
                    : VIEWPORT_HEIGHT;
                node.props.onLayout({
                    nativeEvent: { layout: { height, width: 800, x: 0, y: 0 } },
                });
            }
            await Promise.resolve();
        });
    }

    type FollowHarness = Readonly<{
        nativeScroller: ReturnType<typeof createNativeScroller>;
        /** Append one row and let its late measurement land. */
        appendRow(measuredHeight: number): Promise<void>;
        readMaintainScrollAtEnd(): unknown;
    }>;

    async function mountFollowHarness(dataKey: string): Promise<FollowHarness> {
        const Renderer = legendListRenderer.Component;
        const nativeScroller = createNativeScroller();
        const rowHeights = new Map<string, number>();
        let rows: readonly Row[] = Array.from({ length: 20 }, (_value, index): Row => {
            const id = `${ROW_TEST_ID_PREFIX}${dataKey}-${index}`;
            rowHeights.set(id, VIEWPORT_HEIGHT);
            return { id };
        });
        const render = () => (
            <Renderer
                webDomObservation={createWebDomScrollObservation()}
                data={rows}
                dataKey={dataKey}
                frame={resolveMainTranscriptListShellFrame({
                    legendInitialScrollAtEnd: true,
                    maintainScrollAtEndThreshold: 0.1,
                    nativeID: dataKey,
                    platformOS: 'ios',
                })}
                keyExtractor={(item: Row) => item.id}
                renderItem={({ item }: { item: Row }) => React.createElement('Row', { testID: item.id })}
            />
        );

        await act(async () => {
            screen = create(render(), { createNodeMock: createNodeMock(nativeScroller) });
        });
        const resolveRowHeight = (rowId: string) => rowHeights.get(rowId) ?? VIEWPORT_HEIGHT;
        await flushRowLayouts(requireMountedScreen(screen), resolveRowHeight);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
        });
        await flushRowLayouts(requireMountedScreen(screen), resolveRowHeight);
        // Settle the initial end placement the way the platform does: the scroller reports
        // the landed offset back through onScroll.
        const emitScroll = (offsetY: number, contentHeight: number) => {
            act(() => {
                requireMountedScreen(screen).root.findByType('ScrollView').props.onScroll({
                    nativeEvent: {
                        contentInset: { bottom: 0, left: 0, right: 0, top: 0 },
                        contentOffset: { x: 0, y: offsetY },
                        contentSize: { height: contentHeight, width: 800 },
                        layoutMeasurement: { height: VIEWPORT_HEIGHT, width: 800 },
                        zoomScale: 1,
                    },
                });
            });
        };
        const initialContentHeight = rows.length * VIEWPORT_HEIGHT;
        emitScroll(initialContentHeight - VIEWPORT_HEIGHT, initialContentHeight);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(64);
            await Promise.resolve();
        });

        return {
            nativeScroller,
            async appendRow(measuredHeight: number) {
                const id = `${ROW_TEST_ID_PREFIX}${dataKey}-${rows.length}`;
                rowHeights.set(id, measuredHeight);
                rows = [...rows, { id }];
                await act(async () => {
                    requireMountedScreen(screen).update(render());
                    await Promise.resolve();
                });
                await flushRowLayouts(requireMountedScreen(screen), resolveRowHeight);
                // Legend defers the maintained-end write itself to a frame.
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(64);
                    await Promise.resolve();
                });
            },
            readMaintainScrollAtEnd() {
                return requireMountedScreen(screen).root.findByType(LegendList).props.maintainScrollAtEnd;
            },
        };
    }

    type MaintainProbeRow = Readonly<{ height: number; id: string }>;

    /**
     * Drive the REAL installed native list with the exact `maintainScrollAtEnd` value the
     * renderer hands it, isolated from the app's own viewport writers. This probe answers only
     * "what does Legend do with the renderer's native config".
     */
    async function probeLibraryTailFollow(
        maintainScrollAtEnd: unknown,
    ): Promise<Readonly<{ maintained: boolean; withinThresholdAfterCommit: boolean }>> {
        const listRef = React.createRef<LegendListRef>();
        const nativeScroller = createNativeScroller();
        let rows: readonly MaintainProbeRow[] = Array.from(
            { length: 20 },
            (_value, index): MaintainProbeRow => ({ height: 120, id: `maintain-probe-${index}` }),
        );
        let dataVersion = 0;
        const render = () => (
            <LegendList
                data={rows}
                dataVersion={dataVersion}
                estimatedItemSize={120}
                estimatedListSize={{ height: 600, width: 800 }}
                getFixedItemSize={(item: MaintainProbeRow) => item.height}
                initialScrollAtEnd
                keyExtractor={(item: MaintainProbeRow) => item.id}
                maintainScrollAtEnd={maintainScrollAtEnd as never}
                maintainScrollAtEndThreshold={0.1}
                maintainVisibleContentPosition={{ data: true, size: true }}
                recycleItems={false}
                ref={listRef}
                renderItem={({ item }: { item: MaintainProbeRow }) => (
                    <React.Fragment>{item.id}</React.Fragment>
                )}
            />
        );
        let mountedProbe: ReactTestRenderer | null = null;
        await act(async () => {
            mountedProbe = create(
                render(),
                { createNodeMock: createNodeMock(nativeScroller) },
            );
        });
        const probeScreen = requireMountedScreen(mountedProbe);
        try {
            let readyToRender = false;
            listRef.current!.getState().listen('readyToRender', (value) => {
                readyToRender = value;
            });
            await flushNativeLayouts(probeScreen);
            for (let pass = 0; pass < 48 && !readyToRender; pass += 1) {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(100);
                    await Promise.resolve();
                });
                if (!readyToRender) await flushNativeLayouts(probeScreen);
            }
            expect(readyToRender).toBe(true);

            // Settle at the live tail, then echo the landed offset the way the platform's
            // scroller does so Legend's own proximity fact is current.
            act(() => {
                listRef.current!.scrollToEnd({ animated: false });
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(64);
                await Promise.resolve();
            });
            const settled = listRef.current!.getState();
            act(() => {
                probeScreen.root.findByType('ScrollView').props.onScroll({
                    nativeEvent: {
                        contentInset: { bottom: 0, left: 0, right: 0, top: 0 },
                        contentOffset: { x: 0, y: settled.scroll },
                        contentSize: { height: settled.contentLength, width: 800 },
                        layoutMeasurement: { height: settled.scrollLength, width: 800 },
                        zoomScale: 1,
                    },
                });
            });
            expect(listRef.current!.getState().isWithinMaintainScrollAtEndThreshold).toBe(true);
            nativeScroller.scrollToEnd.mockClear();

            // A streamed row measures far taller than the threshold band, so the same commit
            // that should follow the tail also moves the physical viewport past it.
            rows = [...rows, { height: 1_200, id: `maintain-probe-${rows.length}` }];
            dataVersion += 1;
            await act(async () => {
                probeScreen.update(render());
                await Promise.resolve();
            });
            await flushNativeLayouts(probeScreen);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(64);
                await Promise.resolve();
            });

            return {
                maintained: nativeScroller.scrollToEnd.mock.calls.length > 0,
                withinThresholdAfterCommit:
                    listRef.current!.getState().isWithinMaintainScrollAtEndThreshold,
            };
        } finally {
            act(() => probeScreen.unmount());
        }
    }

    it('keeps end maintenance library-owned when a late measurement leaves the physical threshold', async () => {
        const harness = await mountFollowHarness('native-follow-positive');
        const nativeMaintainConfig = harness.readMaintainScrollAtEnd();
        expect(nativeMaintainConfig).toMatchObject({ animated: false });

        // `refScroller.scrollToEnd` is reached from exactly one place in the installed
        // package (doMaintainScrollAtEnd), so a call there is Legend-owned maintenance; the
        // app's residual writer uses scrollToOffset/scrollTo instead.
        expect(await probeLibraryTailFollow(nativeMaintainConfig)).toEqual({
            // Legend evaluates `withinThreshold || isMaintainingScrollAtEnd()`. With the
            // predicate withheld on native, the beyond-threshold commit silently drops
            // follow and the app corrector has to reposition a frame later - the send jiggle.
            maintained: true,
            // The commit really did leave the proximity band: Legend's own fact says so.
            withinThresholdAfterCommit: false,
        });
    });

    it('does not let Legend re-pin a native hold the user took over inside the physical threshold', async () => {
        const harness = await mountFollowHarness('native-follow-negative');

        // Control: while held-end is live and the viewport sits inside the threshold, Legend
        // maintains. Nothing below moves the viewport, so the physical threshold stays
        // satisfied for the rest of the test.
        await harness.appendRow(VIEWPORT_HEIGHT);
        expect(harness.nativeScroller.scrollToEnd).toHaveBeenCalled();

        // The user puts a finger down at the tail: the semantic owner releases held-end while
        // the viewport has not moved, so the physical threshold is still satisfied. Legend
        // evaluates `withinThreshold || isMaintainingScrollAtEnd()` as an OR, so only the
        // semantic outer gate can stop a re-pin here.
        act(() => {
            requireMountedScreen(screen).root.findByType(LegendList).props.onScrollBeginDrag({
                nativeEvent: { contentOffset: { x: 0, y: 2_280 } },
            });
        });
        expect(harness.readMaintainScrollAtEnd()).toBe(false);
        harness.nativeScroller.scrollToEnd.mockClear();

        await harness.appendRow(VIEWPORT_HEIGHT);

        expect(harness.nativeScroller.scrollToEnd).not.toHaveBeenCalled();
    });
});
