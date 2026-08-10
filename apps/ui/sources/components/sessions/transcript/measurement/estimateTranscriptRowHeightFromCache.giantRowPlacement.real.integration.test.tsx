// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * C-1 · Step 2 — the deeper question, answered against the INSTALLED @legendapp/list 3.3.3
 * (the vendored patch in `patches/@legendapp+list+3.3.3.patch` is applied to node_modules).
 *
 * Row A in the live capture was already measured (box height == DOM height == 21849), yet row B was
 * positioned from a 20,000px ESTIMATE. These tests establish exactly when Legend consults
 * `getEstimatedItemSize` for a row it has already measured, and therefore whether a cached estimate
 * can outlive a measurement.
 */

const ROW_A_MEASURED_PX = 21_849;
const ROW_B_MEASURED_PX = 50;
const CAPTURED_VIEWPORT_PX = 22_341;
/** The former `ESTIMATE_MAX_ROW_PX`, i.e. what this owner used to hand Legend for row A. */
const FORMER_CEILING_PX = 20_000;

/** The live capture's `innerH`. Lowered per-test when a row has to be scrolled out of the window. */
let viewportPx = CAPTURED_VIEWPORT_PX;

type ProbeRow = Readonly<{
    estimatedHeight: number;
    height: number;
    id: string;
    sizeVersion: string;
}>;

type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

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
    if (htmlElement.id === 'giant-row-host') return rect(800, viewportPx);
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        return rect(800, viewportPx);
    }
    const row = htmlElement.querySelector<HTMLElement>('[data-testid^="giant-row-"]');
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

/**
 * What this owner really estimates for the live capture's row A: ~910 wrapped lines of markdown at
 * the estimator's own 72-chars-per-line flow (F1, 2026-08-10 — re-derived from 992 when the
 * per-line term became the row's real 24px `transcriptMarkdownTextStyle.lineHeight`; the capture
 * recorded a painted height, never a character count, so this count is a fixture). Driving the
 * probes from the real estimator (not a literal) is what makes them fail when the ceiling is
 * reinstated.
 */
function estimateGiantMarkdownRowPx(): number {
    const message: Message = {
        kind: 'agent-text',
        id: 'm1',
        localId: null,
        createdAt: 1,
        text: 'x'.repeat(72 * 910),
    } as Message;
    const estimate = estimateTranscriptRowHeightFromContent({
        toolCallsGroupChromeVariant: 'feed_background',
        getMessageById: () => message,
        item: { kind: 'message', id: 'A', messageId: 'm1' } as TranscriptRowShellItem,
    });
    expect(estimate).toBeDefined();
    return estimate as number;
}

function renderProbeRow({ item }: Readonly<{ item: ProbeRow }>): React.ReactElement {
    return (
        <div
            data-height={item.height}
            data-testid={`giant-row-${item.id}`}
            style={{ height: item.height }}
        >
            {item.id}
        </div>
    );
}

describe('C-1 · installed Legend places a giant row\'s successor', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        viewportPx = CAPTURED_VIEWPORT_PX;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        container = document.createElement('div');
        container.style.height = `${viewportPx}px`;
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
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
            function getBoundingClientRect(this: HTMLElement) {
                return measuredRect(this);
            },
        );
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
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get() {
                return (this as HTMLElement & { __scrollTop?: number }).__scrollTop ?? 0;
            },
            set(value: number) {
                (this as HTMLElement & { __scrollTop?: number }).__scrollTop = Math.max(0, value);
            },
        });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function renderList(
        data: readonly ProbeRow[],
        listRef: React.RefObject<LegendListRef | null>,
    ): React.ReactElement {
        return (
            <div id="giant-row-host" style={{ height: viewportPx }}>
                <LegendList
                    data={data}
                    drawDistance={0}
                    estimatedItemSize={100}
                    getEstimatedItemSize={(item) => item.estimatedHeight}
                    getItemSizeVersion={(item) => item.sizeVersion}
                    keyExtractor={(item) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderProbeRow}
                />
            </div>
        );
    }

    /**
     * Q1/Q2 — a MEASURED row governs its successor's position, and the estimate is not consulted
     * again for it. This is the healthy path, and it is why the ceiling only ever mattered for a
     * row Legend had not measured yet (a cold open, or an invalidated one — see Q3).
     */
    it('positions the next row at the giant row\'s measured bottom, ignoring the estimate', async () => {
        const listRef = React.createRef<LegendListRef>();
        const rows: ProbeRow[] = [
            { estimatedHeight: FORMER_CEILING_PX, height: ROW_A_MEASURED_PX, id: 'A', sizeVersion: 'v1' },
            { estimatedHeight: 56, height: ROW_B_MEASURED_PX, id: 'B', sizeVersion: 'v1' },
        ];
        await act(async () => {
            root.render(renderList(rows, listRef));
        });
        await flushLegendWork();

        const state = listRef.current!.getState();
        expect(state.sizes.get('A')).toBe(ROW_A_MEASURED_PX);
        // The successor sits at A's REAL bottom, not at the estimate.
        expect(state.positionAtIndex(1)).toBe(ROW_A_MEASURED_PX);
        expect(state.positionAtIndex(1)).not.toBe(FORMER_CEILING_PX);
    });

    /**
     * Q3 — YES: a cached estimate CAN outlive a measurement.
     *
     * `ChatListInternal` wires Legend's vendored `getItemSizeVersion` to the FULL row-shell
     * signature key, and the patch's `validateItemSizeVersion` responds by deleting the row's
     * `sizesKnown` AND `sizes` entries. The row is then re-sized from `getEstimatedItemSize` — even
     * while it is MOUNTED and painting its real height. That is the live capture's shape exactly:
     * row A painted 21,849px while the content model carried the app's estimate for it.
     *
     * This is why the ceiling was load-bearing rather than cosmetic: with it, that re-size could
     * only ever land on 20,000 for any row taller than 20,000, permanently and by construction.
     */
    it('re-sizes an OFFSCREEN measured row from this owner\'s estimate when its version moves', async () => {
        // A row has to leave the render window for the revert to be observable, so this test uses a
        // phone-sized viewport rather than the capture's.
        viewportPx = 600;
        const listRef = React.createRef<LegendListRef>();
        const giantEstimatePx = estimateGiantMarkdownRowPx();
        const buildRows = (giantSizeVersion: string): ProbeRow[] => ([
            {
                estimatedHeight: giantEstimatePx,
                height: ROW_A_MEASURED_PX,
                id: 'A',
                sizeVersion: giantSizeVersion,
            },
            ...Array.from({ length: 40 }, (_value, index): ProbeRow => ({
                estimatedHeight: 100,
                height: 100,
                id: `after-${index}`,
                sizeVersion: 'v1',
            })),
        ]);

        await act(async () => {
            root.render(renderList(buildRows('v1'), listRef));
        });
        await flushLegendWork();
        // Row A mounts first and measures its real painted height.
        expect(listRef.current!.getState().sizes.get('A')).toBe(ROW_A_MEASURED_PX);

        // Scroll well past A so it unmounts: there is no live DOM node left to re-measure from.
        act(() => {
            listRef.current?.scrollToIndex({ animated: false, index: 25, viewPosition: 0 });
        });
        await flushLegendWork();
        expect(document.querySelector('[data-testid="giant-row-A"]')).toBeNull();

        // A's structural key moves while it is offscreen — a tool settling, a revision bump, a
        // grouping change. `validateItemSizeVersion` deletes its measured size.
        await act(async () => {
            root.render(renderList(buildRows('v2'), listRef));
        });
        await flushLegendWork();

        const state = listRef.current!.getState();
        // ANSWER to Q3: yes — the measurement is gone and this owner's ESTIMATE is now the size that
        // positions every row after A. Under the former ceiling that value was 20,000 for any row
        // taller than 20,000, so a 21,849px row's successor was placed 1,849px inside it, exactly as
        // the live capture measured.
        expect(state.sizes.has('A')).toBe(false);
        expect(state.positionAtIndex(1)).toBe(giantEstimatePx);
        // The fix: the estimate that replaces the measurement is no longer a ceiling, so the
        // successor still lands at or below A's real bottom.
        expect(state.positionAtIndex(1)).toBeGreaterThanOrEqual(ROW_A_MEASURED_PX);
        expect(state.positionAtIndex(1)).not.toBe(FORMER_CEILING_PX);
    });

    /**
     * The end-to-end contract, driven by the REAL estimator rather than a literal: a cold list whose
     * giant row has not measured yet must not place its successor inside it.
     */
    it('places the successor below the giant row on a COLD list, using the real estimator', async () => {
        const estimate = estimateGiantMarkdownRowPx();
        // The estimator's own answer for the live capture's row A, with no ceiling applied.
        expect(estimate).toBeGreaterThanOrEqual(ROW_A_MEASURED_PX);

        const listRef = React.createRef<LegendListRef>();
        // A row far below the viewport never mounts, so its size stays the estimate — this is the
        // accumulation the user scrolls into.
        const rows: ProbeRow[] = [
            { estimatedHeight: 56, height: 56, id: 'head', sizeVersion: 'v1' },
            { estimatedHeight: estimate, height: ROW_A_MEASURED_PX, id: 'A', sizeVersion: 'v1' },
            { estimatedHeight: 56, height: ROW_B_MEASURED_PX, id: 'B', sizeVersion: 'v1' },
        ];
        await act(async () => {
            root.render(renderList(rows, listRef));
        });
        await flushLegendWork();

        const state = listRef.current!.getState();
        const rowATopPx = state.positionAtIndex(1);
        const rowBTopPx = state.positionAtIndex(2);
        // Whether A measured or not, B never begins inside A's painted body.
        expect(rowBTopPx - rowATopPx).toBeGreaterThanOrEqual(ROW_A_MEASURED_PX);
        expect(rowBTopPx - rowATopPx).not.toBe(FORMER_CEILING_PX);
    });
});
