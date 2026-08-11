// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * UNPINNED STREAMING, H1 — "the ANCHOR ROW IS THE GROWING ROW".
 *
 * `legendUnpinnedBelowFoldGrowth.real.integration.test.tsx` measured the append-BELOW-the-fold
 * shape and found zero drift and zero scroll writes in four arms. That refutes "MVCP mishandles
 * content appended below the viewport". It does NOT cover the shape the user actually reports:
 * the reader unpins in the MIDDLE of a long markdown reply, so the row under their eyes is the
 * streaming row itself, spanning and then exceeding the viewport. That is an in-place RESIZE of
 * the anchor row, not an append after it, and the prior harness structurally cannot build it
 * (fixed-height rows, reader always anchored to a different row than the one that grows).
 *
 * Two things make this file able to see what the prior one could not:
 *
 * 1. THE READER SITS INSIDE THE GROWING ROW. `readerOffsetInsideRow` places the scroll position
 *    partway down a row that is already taller than the viewport, so `positions[anchorIndex]` (the
 *    row TOP) is ABOVE the fold. Legend's MVCP anchors on that top (`prepareMVCP` ->
 *    `targetId = idsInView.find(...)`, `prevPosition = positions[targetIndex]`), so a size change
 *    of the anchor row itself yields `positionDiff === 0` and MVCP is *by construction* blind to
 *    it. Whatever moves the reader here moves them without a compensating write.
 *
 * 2. THE BROWSER'S SCROLL CLAMP IS MODELLED. A real scroller cannot hold `scrollTop` greater than
 *    `scrollHeight - clientHeight`: when content shrinks, the browser reduces `scrollTop` itself,
 *    silently, with no scroll write from anyone, and does NOT restore it when the content grows
 *    back. The prior harness clamps only inside its `scrollTop` SETTER, so a shrink that nobody
 *    writes through is invisible to it. Here `settleBrowserScrollClamp()` runs after every layout
 *    pass and records each clamp, which is the only mechanism in this file that can move a reader
 *    with an empty scroll-write census.
 *
 * BASIS: jsdom + the installed `@legendapp/list` 3.3.3 web build, with the transcript's own
 * unpinned prop set (`legendListRenderer.tsx:2857-2943`): `alignItemsAtEnd`,
 * `estimatedItemSize: 240`, `maintainVisibleContentPosition: { data: true, size: true }`,
 * `recycleItems: false`, `maintainScrollAtEnd: false`, and the vendored
 * `getEstimatedItemSize` / `getItemSizeVersion` pair. No compositor, no real text layout: this is
 * evidence about the library's arithmetic and about which mechanism displaces the reader, not a
 * substitute for a live capture.
 *
 * Every zero in this file is backed by an instrument-live control in the same run.
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

type BrowserClamp = Readonly<{
    chunk: number;
    from: number;
    to: number;
}>;

const HOST_ID = 'unpinned-anchor-row-host';
const ROW_PREFIX = 'unpinned-anchor-row-';

const resizeObservers = new Set<ResizeObserverRecord>();
const physicalScrollWrites: PhysicalScrollWrite[] = [];
const directScrollTopWrites: PhysicalScrollWrite[] = [];
let scrollMethodActive = false;
let viewportHeight = 600;

/** Legend's own MVCP compensation path on web: `requestAdjust` -> `ScrollAdjust` -> `scrollAdjustBy` -> `el.scrollBy`. */
function isMvcpWrite(write: PhysicalScrollWrite): boolean {
    return write.stack.includes('requestAdjust')
        || write.stack.includes('ScrollAdjust')
        || write.stack.includes('scrollAdjustBy');
}

function isMaintainAtEndWrite(write: PhysicalScrollWrite): boolean {
    return write.stack.includes('doMaintainScrollAtEnd')
        || write.stack.includes('scrollToEnd');
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

describe('Legend unpinned reader INSIDE the growing row (installed 3.3.3, web build)', () => {
    let container: HTMLDivElement;
    let root: Root;
    /**
     * Legend's own published content size for the mounted list. Read from the ref rather than the
     * DOM because the harness's rows are plain divs: `contentLength` is what the real scroller's
     * `scrollHeight` tracks (`getContentSize` = header + footer + totalSize + paddings), and it is
     * the quantity the browser clamps `scrollTop` against.
     */
    let readContentLength: () => number = () => 0;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        scrollMethodActive = false;
        viewportHeight = 600;
        readContentLength = () => 0;
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
                return Math.max(element.clientHeight, readContentLength());
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get() { return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0; },
            set(value: number) {
                const element = this as HTMLElement & { __scrollTop?: number };
                const max = Math.max(0, element.scrollHeight - element.clientHeight);
                const next = Math.max(0, Math.min(value, max));
                const previous = element.__scrollTop ?? 0;
                element.__scrollTop = next;
                if (!scrollMethodActive) {
                    directScrollTopWrites.push({
                        delta: next - previous,
                        stack: new Error('direct physical scrollTop write').stack ?? '',
                        top: next,
                    });
                }
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? this.scrollTop);
                const previous = this.scrollTop;
                physicalScrollWrites.push({
                    delta: top - previous,
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

    /**
     * The browser's own scroll clamp, which no scroll-write census can observe. A scroller cannot
     * hold `scrollTop > scrollHeight - clientHeight`; the browser reduces it the moment content
     * shrinks and never restores it when the content grows back. Applied after every layout pass,
     * exactly where the compositor would apply it.
     */
    function settleBrowserScrollClamp(
        element: HTMLElement & { __scrollTop?: number },
        chunk: number,
        clamps: BrowserClamp[],
    ): void {
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        const current = element.__scrollTop ?? 0;
        if (current > max) {
            clamps.push({ chunk, from: current, to: max });
            element.__scrollTop = max;
        }
    }

    async function flushLegendWork(
        element: HTMLElement | null,
        chunk: number,
        clamps: BrowserClamp[],
        /**
         * Model the ORDER a browser actually uses. Legend publishes `totalSize` during the React
         * commit; the compositor clamps `scrollTop` against that published size; only afterwards
         * does the row's ResizeObserver deliver its real height. Clamping only AFTER the observers
         * have already restored the true size hides that window entirely — which is the shape of
         * blind spot this corridor has repeatedly mistaken for a clean result.
         */
        clampBeforeMeasure = false,
    ): Promise<void> {
        for (let pass = 0; pass < 8; pass += 1) {
            if (clampBeforeMeasure && element) {
                settleBrowserScrollClamp(element as HTMLElement & { __scrollTop?: number }, chunk, clamps);
            }
            await act(async () => {
                flushResizeObservers();
                await vi.runOnlyPendingTimersAsync();
            });
            if (element) settleBrowserScrollClamp(element as HTMLElement & { __scrollTop?: number }, chunk, clamps);
        }
    }

    /**
     * One streaming trial with the reader parked INSIDE `anchorIndex`.
     *
     * `mutate` produces the next data array for chunk `n`. The recorded quantity is the reader's
     * position WITHIN the anchor row (`scrollTop - positions[anchorIndex]`): constant means the
     * words under the reader's eyes did not move, which is the user-visible contract.
     */
    async function runTrial(params: Readonly<{
        anchorIndex: number;
        chunks: number;
        initialRows: readonly Row[];
        /** See `flushLegendWork`: clamp against the size Legend PUBLISHED, before the row re-measures. */
        clampBeforeMeasure?: boolean;
        maintainScrollAtEnd?: false | Readonly<{ animated: boolean; isMaintainingScrollAtEnd: () => boolean }>;
        mutate: (previous: readonly Row[], chunk: number) => readonly Row[];
        /** How far down the anchor row the reader is parked. Must exceed `viewportHeight` shapes to be inside it. */
        readerOffsetInsideRow: number;
    }>): Promise<Readonly<{
        browserClamps: BrowserClamp[];
        contentLengths: number[];
        directWrites: PhysicalScrollWrite[];
        maintainWrites: PhysicalScrollWrite[];
        maxReaderDriftPx: number;
        mvcpWrites: PhysicalScrollWrite[];
        otherWrites: PhysicalScrollWrite[];
        readerDrift: number[];
    }>> {
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
                    maintainScrollAtEnd={params.maintainScrollAtEnd ?? false}
                    maintainVisibleContentPosition={{ data: true, size: true }}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderRow}
                    style={{ flex: 1, minHeight: 0 }}
                />
            </div>
        );

        const clamps: BrowserClamp[] = [];
        await act(async () => { root.render(render(params.initialRows)); });
        readContentLength = () => listRef.current?.getState().contentLength ?? 0;
        await flushLegendWork(null, 0, clamps);

        const scrollElement = findScrollElement();
        await flushLegendWork(scrollElement, 0, clamps);

        const anchorId = params.initialRows[params.anchorIndex]!.id;
        act(() => {
            listRef.current?.scrollToIndex({ animated: false, index: params.anchorIndex, viewPosition: 0 });
        });
        await flushLegendWork(scrollElement, 0, clamps);
        act(() => {
            const anchorTop = listRef.current!.getState().positionByKey(anchorId)!;
            listRef.current?.scrollToOffset({ animated: false, offset: anchorTop + params.readerOffsetInsideRow });
        });
        await flushLegendWork(scrollElement, 0, clamps);

        /** Where the reader is INSIDE the anchor row. Constant across chunks == nothing moved. */
        const readerOffsetInRow = (): number => (
            scrollElement.scrollTop - listRef.current!.getState().positionByKey(anchorId)!
        );

        // Baseline AFTER placement: everything from here is the unpinned steady state.
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        clamps.length = 0;
        const baseline = readerOffsetInRow();
        const readerDrift: number[] = [];
        const contentLengths: number[] = [];
        let data = params.initialRows;
        for (let chunk = 1; chunk <= params.chunks; chunk += 1) {
            data = params.mutate(data, chunk);
            await act(async () => {
                root.render(render(data));
                flushResizeObservers();
                await Promise.resolve();
            });
            await flushLegendWork(scrollElement, chunk, clamps, params.clampBeforeMeasure === true);
            readerDrift.push(readerOffsetInRow() - baseline);
            contentLengths.push(readContentLength());
        }

        const mvcpWrites = physicalScrollWrites.filter(isMvcpWrite);
        const maintainWrites = physicalScrollWrites.filter(isMaintainAtEndWrite);
        const otherWrites = physicalScrollWrites.filter((write) => !isMvcpWrite(write) && !isMaintainAtEndWrite(write));
        return {
            browserClamps: clamps,
            contentLengths,
            directWrites: [...directScrollTopWrites],
            maintainWrites,
            maxReaderDriftPx: readerDrift.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
            mvcpWrites,
            otherWrites,
            readerDrift,
        };
    }

    function makeRows(count: number, height: number, estimate: number): Row[] {
        return Array.from({ length: count }, (_value, index) => ({
            estimate,
            height,
            id: `row-${index}`,
            sizeVersion: 'v0',
        }));
    }

    /** 30 settled rows, then the streaming reply as the tail row, already taller than the fold. */
    function makeStreamingTailRows(params: Readonly<{
        aboveCount: number;
        aboveEstimate?: number;
        aboveHeight: number;
        streamingEstimate: number;
        streamingHeight: number;
    }>): Row[] {
        const rows = makeRows(params.aboveCount, params.aboveHeight, params.aboveEstimate ?? params.aboveHeight);
        rows.push({
            estimate: params.streamingEstimate,
            height: params.streamingHeight,
            id: `row-${params.aboveCount}`,
            sizeVersion: 'v0',
        });
        return rows;
    }

    const CHUNKS = 12;
    const ABOVE_COUNT = 30;
    const ABOVE_HEIGHT = 300;
    const STREAMING_START_PX = 3000;
    const GROWTH_PER_CHUNK_PX = 400;
    /**
     * Deep inside the row and STRICTLY ABOVE the tail. Content is 30*300 + 3000 = 12000 with a 600
     * fold, so max scroll is 11400; the reader sits at 9000 + 1200 = 10200, i.e. 1200px of the row
     * still below them and the row TOP 1200px above them. Both halves matter: above the fold means
     * MVCP anchors outside the viewport, and below max scroll means the reader is genuinely
     * unpinned rather than parked on the clamp.
     */
    const READER_OFFSET_INSIDE_ROW = 1200;

    it('CONTROL — an idle reader parked inside a tall tail row is not moved by re-render alone', async () => {
        const result = await runTrial({
            anchorIndex: ABOVE_COUNT,
            chunks: CHUNKS,
            initialRows: makeStreamingTailRows({
                aboveCount: ABOVE_COUNT,
                aboveHeight: ABOVE_HEIGHT,
                streamingEstimate: STREAMING_START_PX,
                streamingHeight: STREAMING_START_PX,
            }),
            mutate: (previous) => previous.map((row) => ({ ...row })),
            readerOffsetInsideRow: READER_OFFSET_INSIDE_ROW,
        });

        expect(result.maxReaderDriftPx, JSON.stringify(result.readerDrift)).toBeLessThanOrEqual(1);
        expect(result.browserClamps).toHaveLength(0);
        expect(
            result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
        ).toBe(0);
    });

    it('INSTRUMENT-LIVE CONTROL — growth ABOVE the reader still produces a compensating MVCP write', async () => {
        const result = await runTrial({
            anchorIndex: ABOVE_COUNT,
            chunks: CHUNKS,
            initialRows: makeStreamingTailRows({
                aboveCount: ABOVE_COUNT,
                aboveHeight: ABOVE_HEIGHT,
                streamingEstimate: STREAMING_START_PX,
                streamingHeight: STREAMING_START_PX,
            }),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === ABOVE_COUNT - 2
                    ? {
                        ...row,
                        estimate: ABOVE_HEIGHT + chunk * GROWTH_PER_CHUNK_PX,
                        height: ABOVE_HEIGHT + chunk * GROWTH_PER_CHUNK_PX,
                    }
                    : row
            )),
            readerOffsetInsideRow: READER_OFFSET_INSIDE_ROW,
        });

        expect(
            result.mvcpWrites.length,
            'the instrument must be able to see a Legend MVCP write at all',
        ).toBeGreaterThan(0);
    });

    it('H1-A — the anchor row growing at its BOTTOM does not move a reader parked inside it (stable size version)', async () => {
        const result = await runTrial({
            anchorIndex: ABOVE_COUNT,
            chunks: CHUNKS,
            initialRows: makeStreamingTailRows({
                aboveCount: ABOVE_COUNT,
                aboveHeight: ABOVE_HEIGHT,
                streamingEstimate: STREAMING_START_PX,
                streamingHeight: STREAMING_START_PX,
            }),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === ABOVE_COUNT
                    ? {
                        ...row,
                        estimate: STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX,
                        height: STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX,
                    }
                    : row
            )),
            readerOffsetInsideRow: READER_OFFSET_INSIDE_ROW,
        });

        expect(
            result.maxReaderDriftPx,
            `anchor-row growth moved the reader: ${JSON.stringify({
                clamps: result.browserClamps,
                contentLengths: result.contentLengths,
                readerDrift: result.readerDrift,
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(result.browserClamps).toHaveLength(0);
    });

    it('H1-B — the anchor row whose SIZE VERSION moves each chunk drags the reader with no scroll write at all', async () => {
        // The R2 shape. `ChatListInternal` wires Legend's `getItemSizeVersion` to the row-shell
        // signature; `validateItemSizeVersion` answers a moved version by DELETING `sizesKnown` and
        // `sizes`, so for one pass the row is published at `getEstimatedItemSize` instead of its real
        // measured height. When that estimate undercuts the real height the content total collapses
        // BELOW the reader's scroll offset and the BROWSER clamps `scrollTop` — a displacement no
        // scroll-write census can see, and one MVCP is blind to because the anchor row's TOP never
        // moves (`prepareMVCP` anchors on `positions[targetIndex]`).
        const result = await runTrial({
            anchorIndex: ABOVE_COUNT,
            chunks: CHUNKS,
            initialRows: makeStreamingTailRows({
                aboveCount: ABOVE_COUNT,
                aboveHeight: ABOVE_HEIGHT,
                streamingEstimate: STREAMING_START_PX,
                streamingHeight: STREAMING_START_PX,
            }),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === ABOVE_COUNT
                    ? {
                        ...row,
                        // A content estimate that undercuts the painted row, which is what a flat
                        // 72-chars-per-line model does on a code/table-heavy reply.
                        estimate: Math.round((STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX) * 0.6),
                        height: STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX,
                        sizeVersion: `v${chunk}`,
                    }
                    : row
            )),
            readerOffsetInsideRow: READER_OFFSET_INSIDE_ROW,
        });

        // Reported as a measurement, not asserted as required behaviour: this arm exists to say
        // whether the mechanism is reachable at all.
        expect(
            {
                clamps: result.browserClamps.length,
                drift: result.maxReaderDriftPx,
                writes: result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            },
            `H1-B moved the reader: ${JSON.stringify({
                clamps: result.browserClamps,
                contentLengths: result.contentLengths,
                mvcp: result.mvcpWrites.map((w) => w.delta),
                readerDrift: result.readerDrift,
            })}`,
        ).toEqual({ clamps: 0, drift: 0, writes: 0 });
        expect(result.directWrites).toHaveLength(0);
    });

    it('H1-C — size-version churn on the anchor row, clamped against the size Legend PUBLISHED', async () => {
        // Same data as H1-B, but the browser clamp is evaluated BEFORE the row's ResizeObserver
        // restores its real height. This is the only ordering in which a discarded measurement can
        // reach the compositor, and it is the window H1-B's post-measure clamp cannot see.
        const result = await runTrial({
            anchorIndex: ABOVE_COUNT,
            chunks: CHUNKS,
            clampBeforeMeasure: true,
            initialRows: makeStreamingTailRows({
                aboveCount: ABOVE_COUNT,
                aboveHeight: ABOVE_HEIGHT,
                streamingEstimate: STREAMING_START_PX,
                streamingHeight: STREAMING_START_PX,
            }),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === ABOVE_COUNT
                    ? {
                        ...row,
                        estimate: Math.round((STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX) * 0.6),
                        height: STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX,
                        sizeVersion: `v${chunk}`,
                    }
                    : row
            )),
            readerOffsetInsideRow: READER_OFFSET_INSIDE_ROW,
        });

        expect(
            {
                clamps: result.browserClamps.length,
                drift: result.maxReaderDriftPx,
                writes: result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            },
            `H1-C moved the reader: ${JSON.stringify({
                clamps: result.browserClamps,
                contentLengths: result.contentLengths,
                mvcp: result.mvcpWrites.map((w) => w.delta),
                readerDrift: result.readerDrift,
            })}`,
        ).toEqual({ clamps: 0, drift: 0, writes: 0 });
        expect(result.directWrites).toHaveLength(0);
    });

    it('CLAMP-LIVE CONTROL — a real content shrink DOES clamp the reader, so an empty clamp census is discriminating', async () => {
        // Without this arm every `clamps: []` above would be indistinguishable from a clamp model
        // that never runs. Here the tail row genuinely shrinks below the reader's offset, which is
        // the one thing a browser answers by reducing `scrollTop` itself.
        const result = await runTrial({
            anchorIndex: ABOVE_COUNT,
            chunks: CHUNKS,
            initialRows: makeStreamingTailRows({
                aboveCount: ABOVE_COUNT,
                aboveHeight: ABOVE_HEIGHT,
                streamingEstimate: STREAMING_START_PX,
                streamingHeight: STREAMING_START_PX,
            }),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === ABOVE_COUNT
                    ? {
                        ...row,
                        estimate: STREAMING_START_PX - chunk * GROWTH_PER_CHUNK_PX,
                        height: STREAMING_START_PX - chunk * GROWTH_PER_CHUNK_PX,
                    }
                    : row
            )),
            readerOffsetInsideRow: READER_OFFSET_INSIDE_ROW,
        });

        expect(
            result.browserClamps.length,
            `the browser-clamp model must be able to fire at all: ${JSON.stringify(result.contentLengths)}`,
        ).toBeGreaterThan(0);
        expect(
            result.maxReaderDriftPx,
            'a clamp that does not move the reader would make the clamp census meaningless',
        ).toBeGreaterThan(1);
    });

    it('H2 — rows ABOVE the reader carrying estimates that undercut their painted height', async () => {
        // The estimate-correction shape: rows the reader already scrolled PAST were never measured
        // (opened at the tail, jumped, or restored), so they are placed from estimates. Anything
        // that measures or re-estimates them moves everything below, including the reader.
        const result = await runTrial({
            anchorIndex: ABOVE_COUNT,
            chunks: CHUNKS,
            initialRows: makeStreamingTailRows({
                aboveCount: ABOVE_COUNT,
                aboveEstimate: Math.round(ABOVE_HEIGHT * 0.6),
                aboveHeight: ABOVE_HEIGHT,
                streamingEstimate: STREAMING_START_PX,
                streamingHeight: STREAMING_START_PX,
            }),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === ABOVE_COUNT
                    ? {
                        ...row,
                        estimate: STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX,
                        height: STREAMING_START_PX + chunk * GROWTH_PER_CHUNK_PX,
                    }
                    : row
            )),
            readerOffsetInsideRow: READER_OFFSET_INSIDE_ROW,
        });

        expect(
            {
                clamps: result.browserClamps.length,
                drift: result.maxReaderDriftPx,
                writes: result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            },
            `H2 moved the reader: ${JSON.stringify({
                clamps: result.browserClamps,
                contentLengths: result.contentLengths,
                mvcp: result.mvcpWrites.map((w) => w.delta),
                readerDrift: result.readerDrift,
            })}`,
        ).toEqual({ clamps: 0, drift: 0, writes: 0 });
        expect(result.directWrites).toHaveLength(0);
    });
});
