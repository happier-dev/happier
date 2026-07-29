// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Legend publishes ONE content height for the scroller (`totalSize`, the height of the
 * absolutely-positioned item container) and places every row at `positions[index]`. Those
 * two only agree while `updateItemPositions` walks to the end of the data: the walk is what
 * recomputes `positions`, and only a walk that reaches the end calls `updateTotalSize`.
 *
 * The walk is allowed to stop early (`shouldOptimize` + `breakAt`) whenever the list is
 * moving, and it then returns with the incrementally-maintained total that has already
 * absorbed the size change which triggered the pass, while every position past the break
 * keeps its pre-change value. The published height then exceeds the last row's rendered
 * extent by exactly that change - a screen of blank space under the final row.
 *
 * These tests pin the agreement at the seam that produces the blank space: the published
 * content height equals the last row's position plus its size, reached with the FRESH total
 * (rows move), never by shrinking the total back onto stale positions.
 */

type SizedRow = Readonly<{ id: string }>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const HOST_ID = 'legend-content-size-host';
const ROW_TESTID_PREFIX = 'legend-content-size-row-';
const ROW_HEIGHT = 100;
const ROW_COUNT = 80;
const VIEWPORT_HEIGHT = 500;
const GROWTH_INDEX = 2;
const GROWTH_PX = 300;

const resizeObservers = new Set<ResizeObserverRecord>();
const measuredHeights = new Map<string, number>();

function rect(width: number, height: number): DOMRectReadOnly {
    return {
        bottom: height,
        height,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    };
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === HOST_ID) {
        return rect(800, VIEWPORT_HEIGHT);
    }
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    const row = htmlElement.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    if (row) {
        const id = row.dataset.rowId ?? '';
        return rect(800, measuredHeights.get(id) ?? ROW_HEIGHT);
    }
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 0);
}

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries = [...observer.elements].map((element) => ({
            borderBoxSize: [],
            contentBoxSize: [],
            contentRect: measuredRect(element),
            devicePixelContentBoxSize: [],
            target: element,
        })) as ResizeObserverEntry[];
        if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
    }
}

function renderSizedRow({ item }: Readonly<{ item: SizedRow }>): React.ReactElement {
    return (
        <div
            data-row-id={item.id}
            data-testid={`${ROW_TESTID_PREFIX}${item.id}`}
            style={{ height: measuredHeights.get(item.id) ?? ROW_HEIGHT }}
        >
            {item.id}
        </div>
    );
}

const DATA: readonly SizedRow[] = Array.from({ length: ROW_COUNT }, (_value, index) => ({
    id: `row-${index}`,
}));

function expectedContentHeight(): number {
    return DATA.reduce((total, item) => total + (measuredHeights.get(item.id) ?? ROW_HEIGHT), 0);
}

describe('Legend published content size agrees with the last row extent', () => {
    let container: HTMLDivElement;
    let root: Root;
    let listRef: React.RefObject<LegendListRef | null>;
    let scroller: HTMLElement;

    function renderList(): React.ReactElement {
        return (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    data={DATA}
                    drawDistance={0}
                    estimatedItemSize={ROW_HEIGHT}
                    // The transcript wires an exact per-row estimate, so an unmeasured row
                    // never falls back to the running per-type average. Without it the total
                    // is dominated by that average and cannot discriminate this defect.
                    getEstimatedItemSize={() => ROW_HEIGHT}
                    keyExtractor={(item) => item.id}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderSizedRow}
                />
            </div>
        );
    }

    function findScroller(): HTMLElement {
        const found = [...container.querySelectorAll<HTMLElement>('div')].find(
            (element) => element.style.overflowY === 'auto' || element.style.overflow === 'auto',
        );
        expect(found).toBeDefined();
        return found!;
    }

    /**
     * The size change this suite pins reaches Legend only through the ResizeObserver delivery
     * that `settle`/`settleWhileMoving` flush. If the mounted list is wired to an observer this
     * registry cannot reach, the scenario collapses into a silent no-op and the invariant
     * assertions would fail for a reason that has nothing to do with the invariant.
     */
    function expectMeasurementDeliveryIsWired(): void {
        const observedElements = [...resizeObservers].reduce(
            (total, observer) => total + observer.elements.size,
            0,
        );
        expect(observedElements).toBeGreaterThan(0);
    }

    function setScrollTop(value: number): void {
        (scroller as HTMLElement & { __scrollTop?: number }).__scrollTop = value;
    }

    async function settle(passes = 8): Promise<void> {
        for (let pass = 0; pass < passes; pass += 1) {
            await act(async () => {
                flushResizeObservers();
                await vi.runOnlyPendingTimersAsync();
            });
        }
    }

    /**
     * Keeps the list moving (velocity > 0) while pending layout work drains. Time is advanced
     * one frame at a time on purpose: draining every pending timer would jump the clock past
     * the velocity window and leave the list at rest, which is exactly the state this defect
     * does not occur in.
     */
    async function settleWhileMoving(passes = 10, delta = 8): Promise<void> {
        for (let pass = 0; pass < passes; pass += 1) {
            await act(async () => {
                setScrollTop(scroller.scrollTop + delta);
                scroller.dispatchEvent(new Event('scroll'));
                flushResizeObservers();
                await vi.advanceTimersByTimeAsync(16);
            });
        }
    }

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        measuredHeights.clear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        listRef = React.createRef<LegendListRef>();
        container = document.createElement('div');
        container.style.height = `${VIEWPORT_HEIGHT}px`;
        document.body.appendChild(container);
        root = createRoot(container);

        class TestResizeObserver implements ResizeObserver {
            private readonly record: ResizeObserverRecord;

            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }

            disconnect(): void {
                this.record.elements.clear();
                resizeObservers.delete(this.record);
            }

            observe(target: Element): void {
                resizeObservers.add(this.record);
                this.record.elements.add(target);
            }

            unobserve(target: Element): void {
                this.record.elements.delete(target);
            }
        }

        vi.stubGlobal('ResizeObserver', TestResizeObserver);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect(this: HTMLElement) {
            return measuredRect(this);
        });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get() {
                return measuredRect(this).height;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() {
                return measuredRect(this).width;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                const element = this as HTMLElement;
                let virtualContentHeight = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    virtualContentHeight = Math.max(
                        virtualContentHeight,
                        Number.parseFloat(descendant.style.height || '0') || 0,
                    );
                }
                return Math.max(element.clientHeight, virtualContentHeight);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get() {
                return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0;
            },
            set(value: number) {
                const element = this as HTMLElement & { __scrollTop?: number };
                element.__scrollTop = Math.max(0, value);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
                this.scrollTop = top;
                this.dispatchEvent(new Event('scroll'));
            },
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
            clearTimeout(handle);
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('keeps the published height equal to the last row extent when a row grows while the list is moving', async () => {
        await act(async () => {
            root.render(renderList());
        });
        await settle();
        scroller = findScroller();
        expectMeasurementDeliveryIsWired();

        const lastIndex = ROW_COUNT - 1;
        expect(listRef.current!.getState().contentLength).toBe(expectedContentHeight());
        expect(listRef.current!.getState().positionAtIndex(lastIndex)).toBe(
            expectedContentHeight() - ROW_HEIGHT,
        );

        // Get the list moving first: the early-stop walk is only armed once Legend has enough
        // scroll history to report a velocity.
        await settleWhileMoving(4);

        // A visible row grows without any data change (an image resolves, a code block
        // reflows). Legend absorbs the growth into the published total immediately; the walk
        // it schedules must carry the same growth into every position below the growing row.
        measuredHeights.set(DATA[GROWTH_INDEX].id, ROW_HEIGHT + GROWTH_PX);
        await act(async () => {
            root.render(renderList());
        });
        await settleWhileMoving(6);

        const state = listRef.current!.getState();
        const total = expectedContentHeight();

        // The walk really did stop early: without motion it would have reached the end and
        // this test could not discriminate the defect.
        expect(state.scrollVelocity).not.toBe(0);
        // The fresh total is the truth: the content really is GROWTH_PX taller.
        expect(state.contentLength).toBe(total);
        // Every row below the growth must have moved with it.
        expect(state.positionAtIndex(lastIndex)).toBe(total - ROW_HEIGHT);
        // The invariant the blank space violates.
        expect(state.contentLength).toBe(state.positionAtIndex(lastIndex) + ROW_HEIGHT);
    });

    it('keeps the published height equal to the last row extent when a row shrinks while the list is moving', async () => {
        measuredHeights.set(DATA[GROWTH_INDEX].id, ROW_HEIGHT + GROWTH_PX);

        await act(async () => {
            root.render(renderList());
        });
        await settle();
        scroller = findScroller();
        expectMeasurementDeliveryIsWired();

        const lastIndex = ROW_COUNT - 1;
        expect(listRef.current!.getState().contentLength).toBe(expectedContentHeight());

        await settleWhileMoving(4);

        measuredHeights.set(DATA[GROWTH_INDEX].id, ROW_HEIGHT);
        await act(async () => {
            root.render(renderList());
        });
        await settleWhileMoving(6);

        const state = listRef.current!.getState();
        const total = expectedContentHeight();

        expect(state.scrollVelocity).not.toBe(0);
        expect(state.contentLength).toBe(total);
        expect(state.positionAtIndex(lastIndex)).toBe(total - ROW_HEIGHT);
        expect(state.contentLength).toBe(state.positionAtIndex(lastIndex) + ROW_HEIGHT);
    });
});
