// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Legend derives BOTH the content container height (`totalSize`, written onto the
 * `Containers` div) and every item position from `getItemSize`. For an unmeasured row
 * `getItemSize` caches whatever it first produced — on a cold list that is the
 * `estimatedItemSize` prop — into `state.sizes`, and later refreshes that cache from the
 * learned per-type average only on passes where `preferCachedSize` is false.
 *
 * `preferCachedSize` was `!doMVCP || dataChanged || <adjust in flight>`. The passes that
 * walk the WHOLE list start at index 0 only when `dataChanged` (or a forced full update),
 * and the passes that refresh estimates (`doMVCP`, no adjust in flight) start at the
 * buffered visible index. On an end-anchored list — the transcript's configuration:
 * `alignItemsAtEnd` + `initialScrollAtEnd` + maintainVisibleContentPosition — the buffered
 * index sits at the tail, so the refresh pass never reached the scrollback and the
 * full-walk pass was forbidden from refreshing it. Every row outside the last visible
 * window therefore stayed pinned at `estimatedItemSize` forever.
 *
 * Observable consequence: the scroll extent becomes `measuredRows + estimatedItemSize x
 * unmeasuredRows` instead of the real content, so the tail the list scrolls to is
 * estimated space containing no rows — the transcript renders a viewport of emptiness
 * below its last row. Live web capture (2026-07-27): 16174px of scroll extent for a
 * transcript whose rendered rows spanned 3896px.
 *
 * `dataChanged` implies a full walk from index 0 AND, on these passes, active MVCP data
 * anchoring (`prepareMVCP` snapshots the anchor before positions are rewritten and
 * corrects the scroll afterwards), which is exactly the compensation that makes
 * re-deriving sizes safe. `!doMVCP` and the two scroll-adjust terms still withhold the
 * refresh from every pass that has no compensation.
 *
 * This test pins the contract through the installed package: a list whose rows all
 * measure must report a scroll extent equal to the measured content, and its resting tail
 * must land on the last real row.
 */

type Row = Readonly<{ height: number; id: string }>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const HOST_ID = 'legend-end-anchored-host';
const ROW_TESTID_PREFIX = 'legend-end-anchored-row-';
const VIEWPORT_HEIGHT = 772;
const ROW_COUNT = 200;
const ROW_HEIGHT = 26;
const ESTIMATED_ITEM_SIZE = 240;
const MEASURED_CONTENT_HEIGHT = ROW_COUNT * ROW_HEIGHT;

const resizeObservers = new Set<ResizeObserverRecord>();

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
    if (htmlElement.id === HOST_ID) return rect(800, VIEWPORT_HEIGHT);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, VIEWPORT_HEIGHT);
    }
    const row = htmlElement.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    if (row) return rect(800, Number(row.dataset.height ?? ROW_HEIGHT));
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

async function flushLegendWork(): Promise<void> {
    for (let pass = 0; pass < 12; pass += 1) {
        await act(async () => {
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
    }
}

function renderRow({ item }: Readonly<{ item: Row }>): React.ReactElement {
    return (
        <div
            data-height={item.height}
            data-testid={`${ROW_TESTID_PREFIX}${item.id}`}
            style={{ height: item.height }}
        >
            {item.id}
        </div>
    );
}

describe('Legend end-anchored content size', () => {
    let container: HTMLDivElement;
    let root: Root;
    let listRef: React.RefObject<LegendListRef | null>;

    function renderList(data: readonly Row[]): React.ReactElement {
        return (
            <div id={HOST_ID} style={{ height: VIEWPORT_HEIGHT }}>
                <LegendList
                    alignItemsAtEnd
                    data={data}
                    estimatedItemSize={ESTIMATED_ITEM_SIZE}
                    initialScrollAtEnd
                    keyExtractor={(item) => item.id}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                />
            </div>
        );
    }

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
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
                const max = Math.max(0, element.scrollHeight - element.clientHeight);
                element.__scrollTop = Math.max(0, Math.min(value, max));
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
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const delta = typeof options === 'number' ? (y ?? 0) : (options.top ?? 0);
                this.scrollTo({ top: this.scrollTop + delta });
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

    it('sizes the scroll extent from the learned row size, not the cold estimate, for rows outside the visible window', async () => {
        const data: Row[] = Array.from({ length: ROW_COUNT }, (_value, index) => ({
            height: ROW_HEIGHT,
            id: `row-${index}`,
        }));

        await act(async () => {
            root.render(renderList(data));
        });
        await flushLegendWork();

        const state = listRef.current!.getState();

        // The list learned the real row size from the rows it rendered...
        expect(state.getAverageItemSizes()).toMatchObject({
            default: { average: ROW_HEIGHT },
        });
        // ...but most rows are still unmeasured, so this only holds if their estimate was
        // refreshed from that average instead of staying pinned at `estimatedItemSize`.
        expect((state.sizes as ReadonlyMap<string, number>).size).toBeLessThan(ROW_COUNT);

        // Content container height and the last item's position must both describe the
        // same content. Before the fix this was 38156 (45 measured rows + 155 x 240).
        expect(state.contentLength).toBe(MEASURED_CONTENT_HEIGHT);
        const lastIndex = ROW_COUNT - 1;
        expect((state.positionAtIndex(lastIndex) ?? 0) + ROW_HEIGHT).toBe(MEASURED_CONTENT_HEIGHT);

        // The resting tail lands on real content rather than on estimated empty space.
        expect(state.scroll).toBe(MEASURED_CONTENT_HEIGHT - VIEWPORT_HEIGHT);
        expect(
            container.querySelector(`[data-testid="${ROW_TESTID_PREFIX}row-${lastIndex}"]`),
        ).not.toBeNull();
    });
});
