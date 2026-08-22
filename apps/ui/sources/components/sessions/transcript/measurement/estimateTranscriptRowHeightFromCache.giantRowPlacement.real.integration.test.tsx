// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    estimateTranscriptRowHeightFromCache,
    estimateTranscriptRowHeightFromContent,
} from './estimateTranscriptRowHeightFromCache';
import {
    buildTranscriptItemHeightSignatureKey,
    type TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';
import { createTestTranscriptMeasurementReconciler } from './transcriptMeasurementReconciler';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

/**
 * The RENDERER half of the measurement contract, against the INSTALLED @legendapp/list 3.3.3 with
 * `patches/@legendapp+list+3.3.3.patch` applied to node_modules — not a model of Legend.
 *
 * The unit owners (`estimateTranscriptRowHeightFromCache.giantRowPlacement.test.ts`,
 * `transcriptMeasurementReconciler.settledPeakRelease.test.ts`) pin what this module RETURNS. They
 * cannot show that the value is what positions rows, because the deletion that makes the estimate
 * load-bearing lives in the vendored patch: `validateItemSizeVersion` answers a moved
 * `getItemSizeVersion` by dropping the row's `sizesKnown` AND `sizes` entries. This harness composes
 * the two exactly as `ChatListInternal` does —
 *
 *   getEstimatedItemSize = estimateTranscriptRowHeightFromCache(...) ?? estimateTranscriptRowHeightFromContent(...)
 *   getItemSizeVersion   = buildTranscriptItemHeightSignatureKey(signature)
 *
 * — so a regression in either half shows up as a row landing in the wrong place.
 *
 * This file is excluded from `vitest.config.ts` and runs only under `vitest.integration.config.ts`
 * (`yarn test:integration`), like every other `*.real.integration.test.tsx` harness here.
 */

/**
 * The reference agent reply, MEASURED on device 2026-08-10: a 21,229-character codex answer with
 * 326 hard line breaks painted 13,962px in a 370px column. The same capture measured this module's
 * flat, width-blind content model at +6.7% against it — the error this harness converts into a
 * position.
 */
const MEASURED_REPLY_PX = 13_962;
const REFERENCE_REPLY_HARD_LINES = 326;
const REFERENCE_REPLY_CHARS = 21_229;

/**
 * The former `ESTIMATE_MAX_ROW_PX`. C-1: a size estimate is a POSITION, and Legend accumulates
 * (`positions[i + 1] = positions[i] + size_i`), so a ceiling guarantees UNDERSHOOT — i.e. literal
 * overlap — for every row taller than it.
 */
const FORMER_CEILING_PX = 20_000;

/** Live web capture 2026-07-28, session `cmrxjkh2v0vintmk4445ywy9s`: row A's real painted height. */
const CAPTURED_GIANT_ROW_PX = 21_849;

let viewportPx = 600;

type ProbeRow = Readonly<{
    id: string;
    /** The row's real painted height, driven into jsdom so Legend measures it for real. */
    height: number;
    item: TranscriptRowShellItem;
    signature: TranscriptItemHeightValiditySignature;
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
 * A FIXTURE standing in for the device row: the capture recorded a painted height, a character
 * count and a hard-line count, never the text itself. Reproducing the shape (326 breaks over
 * ~21,229 characters) is what makes the content estimate below land where the device measured it.
 */
function referenceReplyText(): string {
    const lineCount = REFERENCE_REPLY_HARD_LINES + 1;
    const bodyChars = REFERENCE_REPLY_CHARS - REFERENCE_REPLY_HARD_LINES;
    const perLine = Math.floor(bodyChars / lineCount);
    return Array.from({ length: lineCount }, () => 'x'.repeat(perLine)).join('\n');
}

function agentMessage(id: string, text: string): Message {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    } as Message;
}

function messageSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'A',
        kind: 'message:agent',
        // R2: a growing message's structural key is identity-only, so the version does NOT move per
        // chunk and the row's measured size survives the stream.
        structuralKey: 'msg:A:growing',
        widthBucket: 'width:800',
        fontScaleKey: 'font:1',
        groupingMode: 'turn',
        forkContextKey: 'root',
        expansionKey: 'tools:none|thinking:none',
        rowState: 'streaming',
        ...overrides,
    };
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

describe('the installed Legend positions a transcript row from this owner\'s size', () => {
    let container: HTMLDivElement;
    let root: Root;
    let reconciler: ReturnType<typeof createTestTranscriptMeasurementReconciler>;
    let messagesById: Map<string, Message>;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        viewportPx = 600;
        reconciler = createTestTranscriptMeasurementReconciler();
        messagesById = new Map<string, Message>();
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
        // jsdom implements neither; Legend's web build calls `scrollBy` for the MVCP adjust it
        // schedules whenever a row's size CHANGES, which is exactly what the size-version tests
        // below provoke. Same shim as the renderer harnesses in `viewport/shell/renderer`.
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const top = typeof options === 'number' ? (y ?? 0) : (options.top ?? 0);
                (this as HTMLElement & { __scrollTop?: number }).__scrollTop = Math.max(0, top);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            configurable: true,
            value(options: ScrollToOptions | number, y?: number) {
                const delta = typeof options === 'number' ? (y ?? 0) : (options.top ?? 0);
                (this as HTMLElement & { scrollTo: (o: ScrollToOptions) => void }).scrollTo({
                    top: (this as HTMLElement).scrollTop + delta,
                });
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

    /** `ChatListInternal`'s composition, verbatim. */
    function getEstimatedItemSize(item: ProbeRow): number | undefined {
        return estimateTranscriptRowHeightFromCache({
            reconciler,
            signature: item.signature,
        }) ?? estimateTranscriptRowHeightFromContent({
        platformIsWeb: false,
            getMessageById: (messageId) => messagesById.get(messageId) ?? null,
            item: item.item,
            toolCallsGroupChromeVariant: 'feed_background',
        });
    }

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
                    getEstimatedItemSize={getEstimatedItemSize}
                    getItemSizeVersion={(item) => buildTranscriptItemHeightSignatureKey(item.signature)}
                    keyExtractor={(item) => item.id}
                    recycleItems={false}
                    ref={listRef}
                    renderItem={renderProbeRow}
                />
            </div>
        );
    }

    function buildRows(replySignature: TranscriptItemHeightValiditySignature): ProbeRow[] {
        return [
            {
                id: 'A',
                height: MEASURED_REPLY_PX,
                item: { kind: 'message', id: 'A', messageId: 'msg:A' } as TranscriptRowShellItem,
                signature: replySignature,
            },
            ...Array.from({ length: 40 }, (_value, index): ProbeRow => ({
                id: `after-${index}`,
                height: 100,
                item: { kind: 'message', id: `after-${index}`, messageId: `msg:after-${index}` } as TranscriptRowShellItem,
                signature: messageSignature({
                    itemId: `after-${index}`,
                    rowState: 'stable',
                    structuralKey: `msg:after-${index}:r1`,
                }),
            })),
        ];
    }

    /**
     * P1 — the streaming -> stable SETTLE boundary, end to end.
     *
     * R2 keeps the version still across every chunk, so the excursion the user reported no longer
     * happens per write. But BOTH `rowState` and `structuralKey` move at the finalize, so this is
     * the one commit where the patch deletes the reply's measured size while the exact-height cache
     * has no entry for the settled signature yet. Whatever this owner returns at that instant is
     * what every row below the reply is positioned from.
     */
    it('re-positions a settled reply from its own last measurement, not from the content model', async () => {
        const replyText = referenceReplyText();
        messagesById.set('msg:A', agentMessage('msg:A', replyText));

        // What the flat content model would say for this row — the fallback that owned this boundary
        // before the reconciler could serve a real measurement here.
        const contentEstimatePx = estimateTranscriptRowHeightFromContent({
        platformIsWeb: false,
            getMessageById: (messageId) => messagesById.get(messageId) ?? null,
            item: { kind: 'message', id: 'A', messageId: 'msg:A' } as TranscriptRowShellItem,
            toolCallsGroupChromeVariant: 'feed_background',
        }) as number;
        // The device-measured overshoot, reproduced from the row's own shape: this fixture flows to
        // 14,830px against the row's real 13,962px (+6.2%, next to the +6.7% the device measured on
        // the real text). Without that separation the rest of this test could not tell the two
        // answers apart — and 868px is the phantom gap this boundary used to open per settle.
        expect(contentEstimatePx).toBeGreaterThan(MEASURED_REPLY_PX);
        expect(contentEstimatePx - MEASURED_REPLY_PX).toBeGreaterThan(800);

        const listRef = React.createRef<LegendListRef>();
        const streaming = messageSignature();
        await act(async () => {
            root.render(renderList(buildRows(streaming), listRef));
        });
        await flushLegendWork();
        // The reply mounts and Legend measures its real painted height.
        expect(listRef.current!.getState().sizes.get('A')).toBe(MEASURED_REPLY_PX);
        // `ChatListRows`' onLayout hands that same measurement to the reconciler.
        reconciler.recordMeasuredHeight({ signature: streaming, heightPx: MEASURED_REPLY_PX });

        // The user scrolls on while the reply finishes, so the row unmounts: there is no live DOM
        // node left to re-measure from, which is precisely when the estimate becomes the position.
        act(() => {
            listRef.current?.scrollToIndex({ animated: false, index: 25, viewPosition: 0 });
        });
        await flushLegendWork();
        expect(document.querySelector('[data-testid="giant-row-A"]')).toBeNull();

        // The stream finalizes: rowState streaming -> stable and the structural key picks up the
        // message revision. `validateItemSizeVersion` drops the measured size.
        const settled = messageSignature({ rowState: 'stable', structuralKey: 'msg:A:r8' });
        expect(buildTranscriptItemHeightSignatureKey(settled))
            .not.toBe(buildTranscriptItemHeightSignatureKey(streaming));
        await act(async () => {
            root.render(renderList(buildRows(settled), listRef));
        });
        await flushLegendWork();

        const state = listRef.current!.getState();
        expect(state.sizes.has('A')).toBe(false);
        // The row below the reply stays exactly where the reply's real bottom is. Before this fix
        // the reconciler had nothing to serve here and the flat content model took over, moving
        // every following row by the overshoot above.
        expect(state.positionAtIndex(1)).toBe(MEASURED_REPLY_PX);
        expect(state.positionAtIndex(1)).not.toBe(contentEstimatePx);
    });

    /**
     * NEGATIVE — a reply that is still growing must NOT be positioned from its last frame: its
     * content is still arriving, and the content model tracks the live text. This is the half that
     * a "just always serve the last measurement" implementation would break.
     */
    it('keeps sizing a STILL-STREAMING reply from its live content while it is offscreen', async () => {
        const replyText = referenceReplyText();
        messagesById.set('msg:A', agentMessage('msg:A', replyText));
        const contentEstimatePx = estimateTranscriptRowHeightFromContent({
        platformIsWeb: false,
            getMessageById: (messageId) => messagesById.get(messageId) ?? null,
            item: { kind: 'message', id: 'A', messageId: 'msg:A' } as TranscriptRowShellItem,
            toolCallsGroupChromeVariant: 'feed_background',
        }) as number;

        const listRef = React.createRef<LegendListRef>();
        const streaming = messageSignature();
        await act(async () => {
            root.render(renderList(buildRows(streaming), listRef));
        });
        await flushLegendWork();
        reconciler.recordMeasuredHeight({ signature: streaming, heightPx: MEASURED_REPLY_PX });

        act(() => {
            listRef.current?.scrollToIndex({ animated: false, index: 25, viewPosition: 0 });
        });
        await flushLegendWork();

        // Still streaming, but the presentation changes (a thinking block resolving into the reply),
        // so the version moves and the measured size is dropped while the row is still growing.
        const stillGrowing = messageSignature({ kind: 'message:agent2' });
        await act(async () => {
            root.render(renderList(buildRows(stillGrowing), listRef));
        });
        await flushLegendWork();

        const state = listRef.current!.getState();
        expect(state.sizes.has('A')).toBe(false);
        expect(state.positionAtIndex(1)).toBe(contentEstimatePx);
        expect(state.positionAtIndex(1)).not.toBe(MEASURED_REPLY_PX);
    });

    /**
     * C-1 — a COLD list, nothing measured, driven by the real estimator: the successor of a giant
     * row may never begin inside it. A ceiling makes that impossible by construction for every row
     * taller than the ceiling, which is what the live 2026-07-28 capture recorded.
     */
    it('places the successor below a giant unmeasured row, with no ceiling', async () => {
        viewportPx = 22_341;
        // ~910 wrapped lines at this owner's own 72-chars-per-line flow: a FIXTURE for the capture's
        // 21,849px row A, whose character count was never recorded.
        messagesById.set('msg:A', agentMessage('msg:A', 'x'.repeat(72 * 910)));
        const giantEstimatePx = estimateTranscriptRowHeightFromContent({
        platformIsWeb: false,
            getMessageById: (messageId) => messagesById.get(messageId) ?? null,
            item: { kind: 'message', id: 'A', messageId: 'msg:A' } as TranscriptRowShellItem,
            toolCallsGroupChromeVariant: 'feed_background',
        }) as number;
        expect(giantEstimatePx).toBeGreaterThanOrEqual(CAPTURED_GIANT_ROW_PX);

        const listRef = React.createRef<LegendListRef>();
        const rows: ProbeRow[] = [
            {
                id: 'head',
                height: 56,
                item: { kind: 'message', id: 'head', messageId: 'msg:head' } as TranscriptRowShellItem,
                signature: messageSignature({ itemId: 'head', rowState: 'stable', structuralKey: 'msg:head:r1' }),
            },
            {
                id: 'A',
                height: CAPTURED_GIANT_ROW_PX,
                item: { kind: 'message', id: 'A', messageId: 'msg:A' } as TranscriptRowShellItem,
                signature: messageSignature({ rowState: 'stable', structuralKey: 'msg:A:r1' }),
            },
            {
                id: 'B',
                height: 50,
                item: { kind: 'message', id: 'B', messageId: 'msg:B' } as TranscriptRowShellItem,
                signature: messageSignature({ itemId: 'B', rowState: 'stable', structuralKey: 'msg:B:r1' }),
            },
        ];
        await act(async () => {
            root.render(renderList(rows, listRef));
        });
        await flushLegendWork();

        const state = listRef.current!.getState();
        const rowATopPx = state.positionAtIndex(1);
        const rowBTopPx = state.positionAtIndex(2);
        // Whether A measured or not, B never begins inside A's painted body.
        expect(rowBTopPx - rowATopPx).toBeGreaterThanOrEqual(CAPTURED_GIANT_ROW_PX);
        expect(rowBTopPx - rowATopPx).not.toBe(FORMER_CEILING_PX);
    });
});
