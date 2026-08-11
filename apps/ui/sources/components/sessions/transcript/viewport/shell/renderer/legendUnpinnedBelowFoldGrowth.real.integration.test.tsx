// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * UNPINNED STREAMING — "content appended strictly BELOW the viewport must move the reader by
 * exactly zero".
 *
 * The user's report: while a long markdown reply streams and the reader has scrolled away from
 * the tail, the transcript moves under them. On web the DOM does not shift `scrollTop` when
 * content grows below the fold, so any movement means something WROTE scroll position.
 *
 * This file measures the LIBRARY half of that question against the installed
 * `@legendapp/list` 3.3.3 web build, with the transcript's own unpinned prop set:
 *   - `maintainScrollAtEnd: false` — `legendListRenderer.tsx` passes `false` whenever the held
 *     scroll intent is not `'end'`, i.e. exactly while the reader is unpinned;
 *   - `maintainVisibleContentPosition: { data: true, size: true }` (LEGEND_MAINTAIN_VISIBLE_CONTENT_POSITION);
 *   - `alignItemsAtEnd: true`, `recycleItems: false`, `estimatedItemSize: 240`
 *     (LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX);
 *   - the vendored `getItemSizeVersion` / `getEstimatedItemSize` pair that `ChatListInternal`
 *     wires to the row-shell signature and the signature-keyed measured-height cache.
 *
 * `resolveTranscriptListRendererSelection` gives Legend `continuousFollow`,
 * `initialBottomPosition`, `localHeightChangeRestore` and `prependRestore` ownership on the
 * Legend path, so while unpinned the library is the only remaining scroll writer on web. That
 * makes the library-level count the discriminating one.
 *
 * BASIS: jsdom + the installed package. This is current-version evidence about the library's
 * compensation arithmetic and about which writer fires. It does NOT stand in for a live browser
 * capture (no compositor, no browser scroll anchoring, no real text layout).
 *
 * Every case carries its own instrument-live control so a zero cannot be an artefact of a dead
 * instrument: the above-fold arm must record MORE THAN ZERO writes with the same instrument that
 * reports zero for the below-fold arm.
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

const HOST_ID = 'unpinned-below-fold-host';
const ROW_PREFIX = 'unpinned-below-fold-row-';

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

describe('Legend unpinned reader through below-fold content growth (installed 3.3.3, web build)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
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
     * One streaming trial. `mutate` produces the next data array for chunk `n`; the harness
     * re-renders, flushes layout, drains rAF, and records the reader's anchor offset plus every
     * physical scroll write attributable to that chunk.
     */
    async function runTrial(params: Readonly<{
        chunks: number;
        initialRows: readonly Row[];
        /** Mirrors what `legendListRenderer.tsx` passes: `false` while unpinned, the object while held-'end'. */
        maintainScrollAtEnd?: false | Readonly<{ animated: boolean; isMaintainingScrollAtEnd: () => boolean }>;
        mutate: (previous: readonly Row[], chunk: number) => readonly Row[];
        readerIndex: number;
    }>): Promise<Readonly<{
        anchorOffsets: number[];
        maxAnchorDriftPx: number;
        maintainWrites: PhysicalScrollWrite[];
        mvcpWrites: PhysicalScrollWrite[];
        otherWrites: PhysicalScrollWrite[];
        directWrites: PhysicalScrollWrite[];
        contentHeights: number[];
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

        await act(async () => { root.render(render(params.initialRows)); });
        await flushLegendWork();

        act(() => {
            listRef.current?.scrollToIndex({ animated: false, index: params.readerIndex, viewPosition: 0 });
        });
        await flushLegendWork();

        const scrollElement = findScrollElement();
        const readerId = params.initialRows[params.readerIndex]!.id;
        const readerTop = (): number => (
            listRef.current!.getState().positionByKey(readerId)! - scrollElement.scrollTop
        );

        // Baseline AFTER placement: everything from here is the unpinned steady state.
        physicalScrollWrites.length = 0;
        directScrollTopWrites.length = 0;
        const baseline = readerTop();
        const anchorOffsets: number[] = [];
        const contentHeights: number[] = [];
        let data = params.initialRows;
        for (let chunk = 1; chunk <= params.chunks; chunk += 1) {
            data = params.mutate(data, chunk);
            await act(async () => {
                root.render(render(data));
                flushResizeObservers();
                await Promise.resolve();
            });
            await flushLegendWork();
            anchorOffsets.push(readerTop() - baseline);
            contentHeights.push(scrollElement.scrollHeight);
        }

        const mvcpWrites = physicalScrollWrites.filter(isMvcpWrite);
        const maintainWrites = physicalScrollWrites.filter(isMaintainAtEndWrite);
        const otherWrites = physicalScrollWrites.filter((write) => !isMvcpWrite(write) && !isMaintainAtEndWrite(write));
        return {
            anchorOffsets,
            contentHeights,
            directWrites: [...directScrollTopWrites],
            maintainWrites,
            maxAnchorDriftPx: anchorOffsets.reduce((max, value) => Math.max(max, Math.abs(value)), 0),
            mvcpWrites,
            otherWrites,
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

    const CHUNKS = 12;
    const READER_INDEX = 10;
    const GROWTH_PER_CHUNK_PX = 400;

    it('CONTROL — an idle unpinned reader receives no scroll write when nothing grows', async () => {
        const result = await runTrial({
            chunks: CHUNKS,
            initialRows: makeRows(40, 300, 300),
            mutate: (previous) => previous.map((row) => ({ ...row })),
            readerIndex: READER_INDEX,
        });

        expect(result.maxAnchorDriftPx, JSON.stringify(result.anchorOffsets)).toBeLessThanOrEqual(1);
        expect(
            result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            `idle re-render wrote scroll position: ${JSON.stringify({
                maintain: result.maintainWrites.map((w) => w.delta),
                mvcp: result.mvcpWrites.map((w) => w.delta),
                other: result.otherWrites.map((w) => w.delta),
            })}`,
        ).toBe(0);
        expect(result.directWrites).toHaveLength(0);
    });

    it('INSTRUMENT-LIVE CONTROL — above-fold growth DOES produce MVCP writes and still holds the reader', async () => {
        const aboveIndex = READER_INDEX - 4;
        const result = await runTrial({
            chunks: CHUNKS,
            initialRows: makeRows(40, 300, 300),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === aboveIndex
                    ? { ...row, estimate: 300 + chunk * GROWTH_PER_CHUNK_PX, height: 300 + chunk * GROWTH_PER_CHUNK_PX }
                    : row
            )),
            readerIndex: READER_INDEX,
        });

        // This is the assertion that makes every ZERO in this file discriminating.
        expect(
            result.mvcpWrites.length,
            'the instrument must be able to see a Legend MVCP write at all',
        ).toBeGreaterThan(0);
        expect(
            result.maxAnchorDriftPx,
            `MVCP failed to absorb above-fold growth: ${JSON.stringify(result.anchorOffsets)}`,
        ).toBeLessThanOrEqual(1);
    });

    it('SUBJECT A — a row growing strictly BELOW the fold moves the unpinned reader by exactly zero (stable size version)', async () => {
        const streamingIndex = 39;
        const result = await runTrial({
            chunks: CHUNKS,
            initialRows: makeRows(40, 300, 300),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === streamingIndex
                    ? { ...row, estimate: 300 + chunk * GROWTH_PER_CHUNK_PX, height: 300 + chunk * GROWTH_PER_CHUNK_PX }
                    : row
            )),
            readerIndex: READER_INDEX,
        });

        expect(
            result.maxAnchorDriftPx,
            `below-fold growth moved the reader: ${JSON.stringify({
                anchorOffsets: result.anchorOffsets,
                contentHeights: result.contentHeights,
                mvcp: result.mvcpWrites.map((w) => w.delta),
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(
            result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            `below-fold growth wrote scroll position: ${JSON.stringify({
                maintain: result.maintainWrites.map((w) => w.delta),
                mvcp: result.mvcpWrites.map((w) => w.delta),
                other: result.otherWrites.map((w) => w.delta),
            })}`,
        ).toBe(0);
        expect(result.directWrites).toHaveLength(0);
    });

    it('SUBJECT B — a below-fold row whose SIZE VERSION moves each chunk still moves the unpinned reader by exactly zero', async () => {
        // The streaming shape the transcript actually produces: `ChatListInternal` wires
        // `getItemSizeVersion` to the row-shell signature, so any signature-bearing change in a
        // streaming row drops its remembered size and re-derives it from `getEstimatedItemSize`.
        const streamingIndex = 39;
        const result = await runTrial({
            chunks: CHUNKS,
            initialRows: makeRows(40, 300, 300),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === streamingIndex
                    ? {
                        ...row,
                        estimate: 300 + chunk * GROWTH_PER_CHUNK_PX,
                        height: 300 + chunk * GROWTH_PER_CHUNK_PX,
                        sizeVersion: `v${chunk}`,
                    }
                    : row
            )),
            readerIndex: READER_INDEX,
        });

        expect(
            result.maxAnchorDriftPx,
            `below-fold size-version churn moved the reader: ${JSON.stringify({
                anchorOffsets: result.anchorOffsets,
                contentHeights: result.contentHeights,
                mvcp: result.mvcpWrites.map((w) => w.delta),
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(
            result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            `below-fold size-version churn wrote scroll position: ${JSON.stringify({
                maintain: result.maintainWrites.map((w) => w.delta),
                mvcp: result.mvcpWrites.map((w) => w.delta),
                other: result.otherWrites.map((w) => w.delta),
            })}`,
        ).toBe(0);
        expect(result.directWrites).toHaveLength(0);
    });

    it('SUBJECT D — a MOUNTED row growing just below the fold moves the unpinned reader by exactly zero', async () => {
        // The realistic shape: the reader scrolled up a screen or two, so the streaming row is
        // still inside Legend's render window and is really measured by the ResizeObserver
        // (`setSize` -> the `size: true` MVCP pass), rather than only contributing an estimate.
        // Fold bottom is `scrollTop + viewportHeight` = 3000 + 600 = 3600; row 13 starts at 3900.
        const streamingIndex = READER_INDEX + 3;
        const result = await runTrial({
            chunks: CHUNKS,
            initialRows: makeRows(40, 300, 300),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === streamingIndex
                    ? {
                        ...row,
                        estimate: 300 + chunk * GROWTH_PER_CHUNK_PX,
                        height: 300 + chunk * GROWTH_PER_CHUNK_PX,
                        sizeVersion: `v${chunk}`,
                    }
                    : row
            )),
            readerIndex: READER_INDEX,
        });

        expect(
            result.maxAnchorDriftPx,
            `mounted below-fold growth moved the reader: ${JSON.stringify({
                anchorOffsets: result.anchorOffsets,
                contentHeights: result.contentHeights,
                mvcp: result.mvcpWrites.map((w) => w.delta),
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(
            result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            `mounted below-fold growth wrote scroll position: ${JSON.stringify({
                maintain: result.maintainWrites.map((w) => w.delta),
                mvcp: result.mvcpWrites.map((w) => w.delta),
                other: result.otherWrites.map((w) => w.delta),
            })}`,
        ).toBe(0);
        expect(result.directWrites).toHaveLength(0);
    });

    it('FAILURE SIGNATURE — a held-end intent that never released drags the same reader with every chunk', async () => {
        // The counterfactual that makes the ZEROs above meaningful, and the grading rule for a
        // live capture. `legendListRenderer.tsx` only passes the `maintainScrollAtEnd` OBJECT
        // while `heldScrollIntentRef.current?.kind === 'end'`; if the reader's detach fails to
        // release that intent, Legend's `doMaintainScrollAtEnd` calls `scrollToEnd()` on every
        // content change. The reader is then dragged by exactly the growth, with `scrollToEnd`
        // (NOT `scrollAdjustBy`) in the stack — a signature no MVCP write can imitate.
        const streamingIndex = 39;
        const result = await runTrial({
            chunks: CHUNKS,
            initialRows: makeRows(40, 300, 300),
            maintainScrollAtEnd: { animated: false, isMaintainingScrollAtEnd: () => true },
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === streamingIndex
                    ? { ...row, estimate: 300 + chunk * GROWTH_PER_CHUNK_PX, height: 300 + chunk * GROWTH_PER_CHUNK_PX }
                    : row
            )),
            readerIndex: READER_INDEX,
        });

        expect(
            result.maxAnchorDriftPx,
            'an unreleased held-end intent must visibly drag the reader, or this file cannot tell the two causes apart',
        ).toBeGreaterThan(1);
        expect(result.maintainWrites.length + result.otherWrites.length).toBeGreaterThan(0);
    });

    it('SUBJECT C — a below-fold row whose ESTIMATE collapses under its real height still moves the unpinned reader by exactly zero', async () => {
        // Estimate churn: the row's remembered size is dropped every chunk and the replacement
        // estimate is the LEGEND_TRANSCRIPT_ESTIMATED_ITEM_SIZE_PX-class scalar rather than the
        // true height, so the published content total swings by thousands of px per chunk.
        const streamingIndex = 39;
        const result = await runTrial({
            chunks: CHUNKS,
            initialRows: makeRows(40, 300, 300),
            mutate: (previous, chunk) => previous.map((row, index) => (
                index === streamingIndex
                    ? {
                        ...row,
                        estimate: chunk % 2 === 0 ? 240 : 300 + chunk * GROWTH_PER_CHUNK_PX,
                        height: 300 + chunk * GROWTH_PER_CHUNK_PX,
                        sizeVersion: `v${chunk}`,
                    }
                    : row
            )),
            readerIndex: READER_INDEX,
        });

        expect(
            result.maxAnchorDriftPx,
            `below-fold estimate collapse moved the reader: ${JSON.stringify({
                anchorOffsets: result.anchorOffsets,
                contentHeights: result.contentHeights,
                mvcp: result.mvcpWrites.map((w) => w.delta),
            })}`,
        ).toBeLessThanOrEqual(1);
        expect(
            result.mvcpWrites.length + result.maintainWrites.length + result.otherWrites.length,
            `below-fold estimate collapse wrote scroll position: ${JSON.stringify({
                maintain: result.maintainWrites.map((w) => w.delta),
                mvcp: result.mvcpWrites.map((w) => w.delta),
                other: result.otherWrites.map((w) => w.delta),
            })}`,
        ).toBe(0);
        expect(result.directWrites).toHaveLength(0);
    });
});
