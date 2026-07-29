// @vitest-environment node

import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The SAME specifier the transcript renderer imports. `vitest.legend-native.config.ts` is the
// single owner of which artifact it resolves to in this lane (the installed native ESM build), so
// this harness exercises the app's own import mapping rather than reaching past it. The MVCP
// assertion below is the discriminator: the web artifact constant-folds
// `shouldQueueNativeMVCPAdjust` to `false`, so a silent fall-back to it fails here.
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

type Row = Readonly<{ id: string }>;

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

function createNativeScroller() {
    const scroller = {
        flashScrollIndicators: vi.fn(),
        getNativeScrollRef: vi.fn(() => ({})),
        getScrollableNode: vi.fn(() => 41),
        getScrollResponder: vi.fn(),
        scrollTo: vi.fn(),
    };
    scroller.getScrollResponder.mockReturnValue(scroller);
    return scroller;
}

function createNodeMock(nativeScroller: ReturnType<typeof createNativeScroller>) {
    return (element: React.ReactElement) => {
        if (String(element.type) === 'ScrollView') return nativeScroller;
        return {
            measure: (
                callback: (x: number, y: number, width: number, height: number) => void,
            ) => callback(0, 0, 800, 120),
        };
    };
}

async function flushNativeLayouts(screen: ReactTestRenderer): Promise<void> {
    await act(async () => {
        for (const node of screen.root.findAll((candidate) => (
            typeof candidate.props.onLayout === 'function'
        ))) {
            node.props.onLayout({
                nativeEvent: { layout: { height: 120, width: 800, x: 0, y: 0 } },
            });
        }
        await Promise.resolve();
    });
}

describe('installed native Legend prepend ordering', () => {
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

    it('publishes the logical MVCP adjustment before the parent data layout effect', async () => {
        const listRef = React.createRef<LegendListRef>();
        const nativeScroller = createNativeScroller();
        const initialRows = Array.from(
            { length: 12 },
            (_value, index): Row => ({ id: `existing-${index}` }),
        );
        let parentObservation: Readonly<{ anchorOffset: number; scroll: number }> | null = null;

        function Harness(props: Readonly<{ rows: readonly Row[] }>) {
            React.useLayoutEffect(() => {
                if (props.rows.length === initialRows.length) return;
                const state = listRef.current?.getState();
                const anchorPosition = state?.positionByKey('existing-2');
                if (state != null && anchorPosition != null) {
                    parentObservation = {
                        anchorOffset: anchorPosition - state.scroll,
                        scroll: state.scroll,
                    };
                }
            }, [props.rows]);

            return (
                <LegendList
                    data={props.rows}
                    estimatedItemSize={120}
                    estimatedListSize={{ height: 600, width: 800 }}
                    getFixedItemSize={() => 120}
                    keyExtractor={(item: Row) => item.id}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={({ item }: { item: Row }) => (
                        <React.Fragment>{item.id}</React.Fragment>
                    )}
                />
            );
        }

        await act(async () => {
            screen = create(
                <Harness rows={initialRows} />,
                { createNodeMock: createNodeMock(nativeScroller) },
            );
        });
        if (screen == null) {
            throw new Error('Expected the installed native Legend harness to mount');
        }
        const mountedScreen = screen;
        let readyToRender = false;
        const unsubscribeReady = listRef.current!.getState().listen(
            'readyToRender',
            (value) => {
                readyToRender = value;
            },
        );
        await flushNativeLayouts(mountedScreen);
        for (let pass = 0; pass < 24 && !readyToRender; pass += 1) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100);
                await Promise.resolve();
            });
            await flushNativeLayouts(mountedScreen);
        }
        const stateBefore = listRef.current!.getState();
        expect(stateBefore.positionByKey('existing-2')).toBe(240);
        expect(stateBefore.contentLength).toBe(1_440);
        const scrollView = mountedScreen.root.findByType('ScrollView');
        act(() => {
            scrollView.props.onScroll({
                nativeEvent: {
                    contentInset: { bottom: 0, left: 0, right: 0, top: 0 },
                    contentOffset: { x: 0, y: 240 },
                    contentSize: { height: stateBefore.contentLength, width: 800 },
                    layoutMeasurement: { height: 600, width: 800 },
                    zoomScale: 1,
                },
            });
        });
        const anchorOffsetBefore = listRef.current!.getState().positionByKey('existing-2')!
            - listRef.current!.getState().scroll;

        const prependedRows = [
            { id: 'older-a' },
            { id: 'older-b' },
            ...initialRows,
        ];
        await act(async () => {
            mountedScreen.update(<Harness rows={prependedRows} />);
            await Promise.resolve();
        });

        expect(parentObservation).toEqual({
            anchorOffset: anchorOffsetBefore,
            scroll: 480,
        });
        unsubscribeReady();
    });
});
