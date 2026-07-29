// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LegendList,
    type LegendListAverageItemSize,
    type LegendListRef,
} from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * Legend estimates every unmeasured row from `state.averageSizes[itemType]`, a running
 * mean maintained incrementally: `avg` is the mean of the current measured size of each
 * counted key and `num` is how many keys are counted. `getItemSizeVersion` invalidation
 * drops a key from `sizesKnown` so the row is re-measured, which makes the next
 * measurement take the "new sample" branch (`num++`) even though that key is already
 * inside the mean. Every invalidation therefore double-counts the key: `num` inflates
 * monotonically and the replacement branch's sensitivity `(size - prev) / num` collapses,
 * freezing the per-type average away from real row sizes. A frozen average is what
 * produces an oversized content container and rows placed too far from their predecessor.
 *
 * These tests pin the accounting through the installed package's public
 * `getState().getAverageItemSizes()` seam: one contribution per counted key, attributed
 * to the type it was counted under, reversed exactly when it leaves the mean.
 */

type AverageRow = Readonly<{
    fixedHeight?: number;
    height: number;
    id: string;
    itemType: string;
    sizeVersion: string;
}>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const HOST_ID = 'legend-average-host';
const ROW_TESTID_PREFIX = 'legend-average-row-';

const resizeObservers = new Set<ResizeObserverRecord>();
let viewportHeight = 600;

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
        return rect(800, viewportHeight);
    }
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, viewportHeight);
    }
    const row = htmlElement.querySelector<HTMLElement>(`[data-testid^="${ROW_TESTID_PREFIX}"]`);
    if (row) {
        return rect(800, Number(row.dataset.height ?? 72));
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

async function flushLegendWork(): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
        await act(async () => {
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
    }
}

function renderAverageRow({ item }: Readonly<{ item: AverageRow }>): React.ReactElement {
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

function row(
    id: string,
    itemType: string,
    height: number,
    overrides: Partial<AverageRow> = {},
): AverageRow {
    return { height, id, itemType, sizeVersion: 'v1', ...overrides };
}

describe('Legend per-type average item-size accounting across item-size versions', () => {
    let container: HTMLDivElement;
    let root: Root;
    let listRef: React.RefObject<LegendListRef | null>;

    function averages(): Record<string, LegendListAverageItemSize> {
        const state = listRef.current;
        expect(state).not.toBeNull();
        return state!.getState().getAverageItemSizes();
    }

    function knownSizes(): ReadonlyMap<string, number> {
        return listRef.current!.getState().sizes as ReadonlyMap<string, number>;
    }

    function renderList(
        data: readonly AverageRow[],
        options: Readonly<{ useFixedItemSize?: boolean }> = {},
    ): React.ReactElement {
        return (
            <div id={HOST_ID} style={{ height: viewportHeight }}>
                <LegendList
                    data={data}
                    drawDistance={0}
                    estimatedItemSize={100}
                    getFixedItemSize={options.useFixedItemSize ? (item) => item.fixedHeight : undefined}
                    getItemSizeVersion={(item) => item.sizeVersion}
                    getItemType={(item) => item.itemType}
                    keyExtractor={(item) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderAverageRow}
                />
            </div>
        );
    }

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        viewportHeight = 600;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        listRef = React.createRef<LegendListRef>();
        container = document.createElement('div');
        container.style.height = '600px';
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
                let materializedTotal = 0;
                for (const materialized of element.querySelectorAll<HTMLElement>('[data-height]')) {
                    materializedTotal += Number(materialized.dataset.height ?? 0);
                }
                let virtualContentHeight = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    virtualContentHeight = Math.max(
                        virtualContentHeight,
                        Number.parseFloat(descendant.style.height || '0') || 0,
                    );
                }
                return Math.max(element.clientHeight, materializedTotal, virtualContentHeight);
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

    it('keeps the per-type average and sample count unchanged when a version bump replays the same size', async () => {
        const initial = Array.from({ length: 4 }, (_value, index) => row(`same-${index}`, 'a', 100));

        await act(async () => {
            root.render(renderList(initial));
        });
        await flushLegendWork();
        expect(averages()).toEqual({ a: { average: 100, count: 4 } });

        const revised = initial.map((item, index) => (
            index === 0 ? { ...item, sizeVersion: 'v2' } : item
        ));
        await act(async () => {
            root.render(renderList(revised));
        });
        await flushLegendWork();

        expect(averages()).toEqual({ a: { average: 100, count: 4 } });
    });

    it('counts exactly one contribution per key when a version bump replaces a measured size', async () => {
        // Unequal samples: dropping the key's count without also removing its measured value
        // from the mean stays invisible when every sample is identical.
        const initial = [60, 100, 140, 180].map((height, index) => (
            row(`replace-${index}`, 'a', height)
        ));

        await act(async () => {
            root.render(renderList(initial));
        });
        await flushLegendWork();
        expect(averages()).toEqual({ a: { average: 120, count: 4 } });

        const revised = initial.map((item, index) => (
            index === 0 ? { ...item, height: 260, sizeVersion: 'v2' } : item
        ));
        await act(async () => {
            root.render(renderList(revised));
        });
        await flushLegendWork();

        // (260 + 100 + 140 + 180) / 4
        expect(averages()).toEqual({ a: { average: 170, count: 4 } });
    });

    it('moves a contribution from its original type to its new type across a version bump', async () => {
        const initial = [
            row('typed-0', 'a', 100),
            row('typed-1', 'a', 100),
            row('typed-2', 'b', 150),
            row('typed-3', 'b', 150),
        ];

        await act(async () => {
            root.render(renderList(initial));
        });
        await flushLegendWork();
        expect(averages()).toEqual({
            a: { average: 100, count: 2 },
            b: { average: 150, count: 2 },
        });

        const revised = initial.map((item, index) => (
            index === 0 ? { ...item, height: 150, itemType: 'b', sizeVersion: 'v2' } : item
        ));
        await act(async () => {
            root.render(renderList(revised));
        });
        await flushLegendWork();

        expect(averages()).toEqual({
            a: { average: 100, count: 1 },
            b: { average: 150, count: 3 },
        });
    });

    it('never records or reverses a contribution for a fixed-size or zero-size measurement', async () => {
        const initial = [
            row('mixed-0', 'measured', 100),
            row('mixed-1', 'measured', 0),
            row('mixed-2', 'measured', 100),
            row('mixed-3', 'fixed', 60, { fixedHeight: 60 }),
        ];

        await act(async () => {
            root.render(renderList(initial, { useFixedItemSize: true }));
        });
        await flushLegendWork();
        expect(averages()).toEqual({ measured: { average: 100, count: 2 } });

        const revised = initial.map((item, index) => {
            if (index === 0) return { ...item, height: 200, sizeVersion: 'v2' };
            if (index === 1) return { ...item, sizeVersion: 'v2' };
            return item;
        });
        await act(async () => {
            root.render(renderList(revised, { useFixedItemSize: true }));
        });
        await flushLegendWork();

        // The zero-size row never entered the mean, so only mixed-0's replacement moves it.
        expect(averages()).toEqual({ measured: { average: 150, count: 2 } });
    });

    it('restores an exact single-sample average when the last member of a type bucket is revalidated', async () => {
        const initial = [
            row('solo-0', 'a', 100),
            row('solo-1', 'a', 100),
            row('solo-2', 'solo', 140),
        ];

        await act(async () => {
            root.render(renderList(initial));
        });
        await flushLegendWork();
        expect(averages()).toEqual({
            a: { average: 100, count: 2 },
            solo: { average: 140, count: 1 },
        });

        const revised = initial.map((item, index) => (
            index === 2 ? { ...item, height: 260, sizeVersion: 'v2' } : item
        ));
        await act(async () => {
            root.render(renderList(revised));
        });
        await flushLegendWork();

        // Reversing the only sample must empty the bucket rather than leave the old value
        // averaged against a second sample for the same key.
        expect(averages()).toEqual({
            a: { average: 100, count: 2 },
            solo: { average: 260, count: 1 },
        });
    });

    it('clears recorded contributions with the size caches so a later bump cannot reverse a stale sample', async () => {
        // The rows only reachable by scrolling measure differently from the head rows, so a
        // contribution recorded before the cache clear is numerically distinguishable from
        // the mean the clear rebuilds.
        const initial = Array.from({ length: 50 }, (_value, index) => (
            row(`reset-${index}`, 'a', index >= 25 ? 300 : 100)
        ));

        await act(async () => {
            root.render(renderList(initial));
        });
        await flushLegendWork();

        act(() => {
            void listRef.current?.scrollToIndex({ animated: false, index: 30, viewPosition: 0 });
        });
        await flushLegendWork();

        act(() => {
            listRef.current?.clearCaches({ mode: 'sizes' });
        });
        await flushLegendWork();

        // Preconditions: clearing the size caches re-anchors the window at the head, so the
        // rows measured while scrolled away keep a recorded contribution that the reset
        // averages no longer contain.
        expect(knownSizes().has('reset-31')).toBe(false);
        expect(knownSizes().has('reset-3')).toBe(true);
        const beforeBump = averages().a;
        expect(beforeBump.average).toBe(100);
        expect(beforeBump.count).toBeGreaterThan(1);

        const revised = initial.map((item, index) => {
            if (index === 31) return { ...item, height: 500, sizeVersion: 'v2' };
            if (index === 3) return { ...item, height: 200, sizeVersion: 'v2' };
            return item;
        });
        await act(async () => {
            root.render(renderList(revised));
        });
        await flushLegendWork();

        // Every key still holding a measured size is exactly one contribution, and no key
        // outside that set may be added to or subtracted from the mean. `reset-3` proves the
        // replacement is not double-counted; `reset-31`'s pre-clear sample must neither
        // survive in the mean nor be subtracted back out of it.
        const measuredSizes = [...knownSizes().values()];
        expect(measuredSizes.length).toBeGreaterThan(beforeBump.count);
        const afterBump = averages().a;
        expect(afterBump.count).toBe(measuredSizes.length);
        expect(afterBump.average).toBeCloseTo(
            measuredSizes.reduce((total, size) => total + size, 0) / measuredSizes.length,
            5,
        );
    });
});
