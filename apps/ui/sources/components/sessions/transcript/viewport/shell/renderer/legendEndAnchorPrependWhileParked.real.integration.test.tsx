// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * END-ANCHOR vs PREPEND — "a history materialization commit must keep the reader's anchor unless
 * end-follow still owns the viewport after that commit".
 *
 * The vendored patch's `HAPPIER-MVCP-END-ANCHOR` block replaces a data commit's anchor-preserving
 * correction with end geometry (`maxScroll − prevScroll`) whenever end-follow ownership is reported
 * during the commit. A prepend while the reader is parked at the top of a short loaded range made
 * that overwrite visible (contributor live capture on 0.2.19 web: +30,998 end geometry against a
 * +29,958 preserve value; ported by intent from the 0.2 line). The guard leaves a commit that
 * inserted content above the reader's anchor to the anchor-preserving correction.
 *
 * Scope, measured here rather than assumed: if end-follow ownership is STILL reported after the
 * commit, Legend's own end maintenance (`doMaintainScrollAtEndFrame` → `scrollToEnd`) follows the
 * tail one frame later anyway — correctly so for a real follower. The guard therefore matters when
 * ownership is released between the commit and that frame, so the SUBJECT drives exactly that.
 *
 * The contract under test, at the library boundary the app actually consumes:
 *   1. SUBJECT — end-follow reported during the prepend commit and released before the next
 *      frame ⇒ the commit spends exactly the anchor-preserving correction (the prepend height),
 *      never end geometry. jsdom cannot resolve post-prepend row positions from real layout, so
 *      the spent correction is the oracle.
 *   2. CONTROL — above-fold row growth with the unowned prop set DOES produce MVCP writes and
 *      holds the reader: the instrument is live and the preserve path is intact.
 *   3. PURPOSE — an owned reader at the end still lands at the new end, through a below-end append
 *      and through a prepend: for a reader AT the tail the anchor-preserving correction and the end
 *      geometry coincide, so the guard cannot cost a real follower the tail.
 *
 * 0.3 mapping note: this line's patch evaluates the end-anchor only inside the
 * `|positionDiff| > MVCP_POSITION_EPSILON` branch, so a pure below-end append (anchor unmoved)
 * reaches the new end through Legend's end maintenance rather than an in-commit MVCP write. The
 * 0.2 harness's "within the data commit" assertion is a property of 0.2's patch shape, not of the
 * guard, and is deliberately not carried here.
 *
 * BASIS: jsdom + the installed patched `@legendapp/list` 3.3.3 web build, with the transcript's
 * own list props (`maintainVisibleContentPosition: { data: true, size: true }`,
 * `alignItemsAtEnd`, `estimatedItemSize: 240`, the vendored size-version pair).
 */

type Row = Readonly<{
    estimate: number;
    height: number;
    id: string;
    sizeVersion: string;
}>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

type PhysicalScrollWrite = Readonly<{
    delta: number;
    stack: string;
    top: number;
}>;

const HOST_ID = 'end-anchor-prepend-host';
const ROW_PREFIX = 'end-anchor-prepend-row-';

const resizeObservers = new Set<ResizeObserverRecord>();
const physicalScrollWrites: PhysicalScrollWrite[] = [];
let scrollMethodActive = false;
let viewportHeight = 600;

function isMvcpWrite(write: PhysicalScrollWrite): boolean {
    return write.stack.includes('requestAdjust')
        || write.stack.includes('ScrollAdjust')
        || write.stack.includes('scrollAdjustBy');
}

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
    if (htmlElement.id === HOST_ID) return rect(800, viewportHeight);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, viewportHeight);
    }
    const row = htmlElement.querySelector<HTMLElement>(`[data-testid^="${ROW_PREFIX}"]`);
    if (row) return rect(800, Number(row.dataset.height ?? 72));
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 80);
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

function renderRow({ item }: Readonly<{ item: Row }>): React.ReactElement {
    return (
        <div
            data-height={item.height}
            data-testid={`${ROW_PREFIX}${item.id}`}
            style={{ height: item.height }}
        >
            {item.id}
        </div>
    );
}

function findScrollElement(): HTMLElement {
    const element = document.getElementById(HOST_ID)?.querySelector<HTMLElement>('[style*="overflow"]');
    expect(element).not.toBeNull();
    return element!;
}

function makeRows(prefix: string, count: number, height: number): Row[] {
    return Array.from({ length: count }, (_value, index) => ({
        estimate: height,
        height,
        id: `${prefix}-${index}`,
        sizeVersion: 'v0',
    }));
}

describe('Legend end-anchor ownership through a prepend materialization (installed 3.3.3, web build)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        physicalScrollWrites.length = 0;
        scrollMethodActive = false;
        viewportHeight = 600;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
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
            get() { return measuredRect(this).height; },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() { return measuredRect(this).width; },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                const element = this as HTMLElement;
                let materializedTotal = 0;
                for (const row of element.querySelectorAll<HTMLElement>('[data-height]')) {
                    materializedTotal += Number(row.dataset.height ?? 0);
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
            get() { return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0; },
            set(value: number) {
                const element = this as HTMLElement & { __scrollTop?: number };
                const max = Math.max(0, element.scrollHeight - element.clientHeight);
                const next = Math.max(0, Math.min(value, max));
                element.__scrollTop = next;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
                physicalScrollWrites.push({
                    delta: top - this.scrollTop,
                    stack: new Error('legend physical scroll write').stack ?? '',
                    top,
                });
                scrollMethodActive = true;
                try {
                    this.scrollTop = top;
                } finally {
                    scrollMethodActive = false;
                }
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
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => { clearTimeout(handle); });
    });

    afterEach(async () => {
        await act(async () => { root.unmount(); });
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    async function mountAndPlace(params: Readonly<{
        data: readonly Row[];
        maintainScrollAtEnd: false | Readonly<{ animated: boolean; isMaintainingScrollAtEnd: () => boolean }>;
        placeAtIndex?: number;
        placeViewPosition?: number;
    }>): Promise<Readonly<{ listRef: React.RefObject<LegendListRef | null>; render: (data: readonly Row[]) => React.ReactElement }>> {
        const listRef = React.createRef<LegendListRef>();
        const render = (data: readonly Row[]) => (
            <div id={HOST_ID} style={{ height: viewportHeight }}>
                <LegendList
                    alignItemsAtEnd
                    data={data}
                    estimatedItemSize={240}
                    getEstimatedItemSize={(item: Row) => item.estimate}
                    getItemType={() => 'message'}
                    getItemSizeVersion={(item: Row) => item.sizeVersion}
                    keyExtractor={(item: Row) => item.id}
                    maintainScrollAtEnd={params.maintainScrollAtEnd}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );

        await act(async () => { root.render(render(params.data)); });
        await flushLegendWork();

        if (params.placeAtIndex != null) {
            act(() => {
                listRef.current?.scrollToIndex({ animated: false, index: params.placeAtIndex!, viewPosition: params.placeViewPosition ?? 0 });
            });
            await flushLegendWork();
        }

        physicalScrollWrites.length = 0;
        return { listRef, render };
    }

    it('SUBJECT — a prepend commit keeps the parked reader when end-follow is released before the next frame', async () => {
        // Loaded range of ~6 viewports with the reader parked at its top; the tail below the
        // reader keeps end geometry (prepend + tail) well away from the preserve value (prepend).
        let endFollowReported = true;
        const initialRows = makeRows('tail', 12, 250);
        const { render } = await mountAndPlace({
            data: initialRows,
            maintainScrollAtEnd: { animated: false, isMaintainingScrollAtEnd: () => endFollowReported },
            placeAtIndex: 0,
        });
        const scrollElement = findScrollElement();
        expect(scrollElement.scrollTop, 'the reader must be parked at the top before the prepend').toBe(0);

        // One history materialization commit: 30,000px of older rows prepended above the reader,
        // with end-follow still reported while it commits.
        const prependedRows = makeRows('hist', 100, 300);
        const prependHeightPx = prependedRows.reduce((total, row) => total + row.height, 0);
        const materialized = [...prependedRows, ...initialRows];
        await act(async () => {
            root.render(render(materialized));
            flushResizeObservers();
            await Promise.resolve();
        });
        endFollowReported = false;
        await flushLegendWork();

        // jsdom cannot resolve post-prepend row positions from real layout, so the oracle is the
        // correction the commit spends: exactly the prepend height (anchor preserved), never the
        // end geometry (`maxScroll − prevScroll`) and never a later end-follow write.
        expect(
            physicalScrollWrites.map((write) => write.top),
            `the prepend did not keep the parked reader's anchor: ${JSON.stringify({
                prependHeightPx,
                writes: physicalScrollWrites.map((write) => ({ delta: write.delta, top: write.top })),
            })}`,
        ).toEqual([prependHeightPx]);
    });

    it('CONTROL — above-fold growth with the unowned prop set is absorbed by MVCP writes (instrument liveness)', async () => {
        const initialRows = makeRows('tail', 40, 300);
        const { listRef, render } = await mountAndPlace({
            data: initialRows,
            maintainScrollAtEnd: false,
            placeAtIndex: 10,
        });
        const scrollElement = findScrollElement();
        const readerId = initialRows[10]!.id;
        const readerTopBefore = listRef.current!.getState().positionByKey(readerId)! - scrollElement.scrollTop;

        const grown = initialRows.map((row, index) => (
            index === 6 ? { ...row, height: 3000, estimate: 3000 } : row
        ));
        await act(async () => {
            root.render(render(grown));
            flushResizeObservers();
            await Promise.resolve();
        });
        await flushLegendWork();

        const readerTopAfter = listRef.current!.getState().positionByKey(readerId)! - scrollElement.scrollTop;
        expect(
            physicalScrollWrites.filter(isMvcpWrite).length,
            'the instrument must be able to see a Legend MVCP write at all',
        ).toBeGreaterThan(0);
        expect(
            Math.abs(readerTopAfter - readerTopBefore),
            `MVCP failed to absorb above-fold growth: before=${readerTopBefore} after=${readerTopAfter}`,
        ).toBeLessThanOrEqual(1);
    });

    it('PURPOSE — an owned reader at the end still lands at the new end through a below-end append', async () => {
        const initialRows = makeRows('tail', 6, 250);
        const { render } = await mountAndPlace({
            data: initialRows,
            maintainScrollAtEnd: { animated: false, isMaintainingScrollAtEnd: () => true },
            placeAtIndex: initialRows.length - 1,
            placeViewPosition: 1,
        });
        const scrollElement = findScrollElement();

        const appended = [...initialRows, ...makeRows('streamed', 4, 250)];
        await act(async () => {
            root.render(render(appended));
            flushResizeObservers();
            await Promise.resolve();
        });
        await flushLegendWork();

        const distanceFromEndAfter = scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop;
        expect(
            distanceFromEndAfter,
            `an owned tail reader must land at the new end: ${JSON.stringify({
                distanceFromEndAfter,
                writes: physicalScrollWrites.map((write) => ({ delta: write.delta, top: write.top })),
            })}`,
        ).toBeLessThanOrEqual(1);
    });

    it('PURPOSE — an owned reader at the end stays at the end through a prepend commit', async () => {
        const initialRows = makeRows('tail', 6, 250);
        const { render } = await mountAndPlace({
            data: initialRows,
            maintainScrollAtEnd: { animated: false, isMaintainingScrollAtEnd: () => true },
            placeAtIndex: initialRows.length - 1,
            placeViewPosition: 1,
        });
        const scrollElement = findScrollElement();

        const materialized = [...makeRows('hist', 100, 300), ...initialRows];
        await act(async () => {
            root.render(render(materialized));
            flushResizeObservers();
            await Promise.resolve();
        });
        await flushLegendWork();

        const distanceFromEndAfter = scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop;
        expect(
            distanceFromEndAfter,
            `an owned tail reader must stay at the end through a prepend: ${JSON.stringify({
                distanceFromEndAfter,
                writes: physicalScrollWrites.map((write) => ({ delta: write.delta, top: write.top })),
            })}`,
        ).toBeLessThanOrEqual(1);
    });
});
