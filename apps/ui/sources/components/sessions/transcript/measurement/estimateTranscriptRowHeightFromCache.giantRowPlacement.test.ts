import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * C-1 — a size ESTIMATE is a POSITION, so it may not carry a ceiling.
 *
 * `ChatListInternal` hands this module's result to the vendored Legend list as
 * `getEstimatedItemSize`, and Legend places rows by ACCUMULATION:
 * `positions[i + 1] = positions[i] + size_i`. An estimate that OVERSHOOTS a row's painted
 * height is therefore a literal gap underneath it — and, inverted, an estimate that
 * UNDERSHOOTS is a literal OVERLAP. A ceiling guarantees undershoot for every row taller than
 * it, unconditionally, so it converts "we do not know this row's height" into "we know it is
 * wrong".
 *
 * The failure was captured live on the sibling repo (web, 2026-07-28, session
 * `cmrxjkh2v0vintmk4445ywy9s`) while a row painted ON TOP OF the message above it:
 *
 * ```
 * row A  transcript-item-msg:8y606ubqcvm  top =  2285   height = 21849 (matches its DOM height)
 * row B  transcript-item-msg:xocdt74v8li  top = 22285   height =    50 (matches its DOM height)
 * container innerH = 22341 | scrollHeight = 24146 | tail after the last row = 1811px
 * ```
 *
 * Every HEIGHT in that capture was right; only B's POSITION was wrong, and the arithmetic
 * names the owner: `B.top 22285 = A.top 2285 + 20000`, while A's real height is 21849 —
 * `21849 - 20000 = 1849` is exactly the measured overlap, and the same 1849px re-surfaces as
 * the phantom tail below the last row. 20000 was this module's own `ESTIMATE_MAX_ROW_PX`.
 *
 * A 21,849px markdown message is legitimate content, so the ceiling cannot be defended as a
 * guard against absurd input. The estimate is superseded by that row's own `onLayout` anyway,
 * so accommodating the real height costs nothing and bounding it costs a broken layout.
 */
describe('C-1 · a giant row must position its successor at its TRUE bottom', () => {
    /** Row A's real painted height, from the capture above. */
    const MEASURED_ROW_A_PX = 21_849;
    /** Row A's real top, from the capture above. */
    const ROW_A_TOP_PX = 2_285;
    /** Row B's real painted height, from the capture above. */
    const MEASURED_ROW_B_PX = 50;
    /** Where row B actually landed — inside row A. */
    const CAPTURED_ROW_B_TOP_PX = 22_285;
    /** The ceiling this owner applied, and the whole of the defect. */
    const CAPTURED_CEILING_PX = 20_000;

    /**
     * The capture recorded row A's painted HEIGHT, never its character count, so the line count
     * below is a FIXTURE derived from this module's own text flow — 72 chars per wrapped line —
     * chosen so the estimate lands within one wrapped line of row A's real 21,849px. It is not a
     * measurement, and F1 (2026-08-10) re-derived it when the per-line term became the row's real
     * `transcriptMarkdownTextStyle.lineHeight`: `22 + 910 x 24 = 21,862`, 13px over the capture,
     * where the previous `32 + 992 x 22` landed 7px over. The contract these cases pin is
     * unchanged — no ceiling, successor at or below the true bottom, monotone in content.
     */
    const GIANT_MARKDOWN_LINES = 910;
    /** `ESTIMATE_CHARS_PER_LINE` — the estimator's flat, width-blind wrap. */
    const ESTIMATE_CHARS_PER_LINE = 72;
    const GIANT_MARKDOWN_CHARS = ESTIMATE_CHARS_PER_LINE * GIANT_MARKDOWN_LINES;
    /** `agentMessageContainer.paddingBottom` — an agent reply paints no bubble (`MessageView.tsx`). */
    const AGENT_ROW_CHROME_PX = 22;
    /** `transcriptMarkdownTextStyle.lineHeight`. */
    const TRANSCRIPT_MARKDOWN_LINE_PX = 24;
    const UNCEILED_ROW_A_ESTIMATE_PX = AGENT_ROW_CHROME_PX + (GIANT_MARKDOWN_LINES * TRANSCRIPT_MARKDOWN_LINE_PX);

    function agentText(id: string, text: string): Message {
        return {
            kind: 'agent-text',
            id,
            localId: null,
            createdAt: 1,
            text,
        } as Message;
    }

    function estimateMessageRowPx(text: string): number {
        const estimate = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => agentText('m1', text),
            item: { kind: 'message', id: 'i1', messageId: 'm1' } as TranscriptRowShellItem,
        });
        expect(estimate).toBeDefined();
        return estimate as number;
    }

    it('estimates the 21,849px markdown row from its content, not from a ceiling', () => {
        const estimate = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        expect(estimate).not.toBe(CAPTURED_CEILING_PX);
        expect(estimate).toBe(UNCEILED_ROW_A_ESTIMATE_PX);
        // Within a wrapped line of the row's real painted height.
        expect(Math.abs(estimate - MEASURED_ROW_A_PX)).toBeLessThanOrEqual(TRANSCRIPT_MARKDOWN_LINE_PX);
    });

    it('places the next row at or below the giant row\'s real bottom', () => {
        const rowAEstimatePx = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        const rowBTopPx = ROW_A_TOP_PX + rowAEstimatePx;
        const rowABottomPx = ROW_A_TOP_PX + MEASURED_ROW_A_PX;
        // Negative is overlap. The capture measured -1849; a healthy transcript is >= 0.
        const gapPx = rowBTopPx - rowABottomPx;

        expect(rowBTopPx).not.toBe(CAPTURED_ROW_B_TOP_PX);
        expect(gapPx).toBeGreaterThanOrEqual(0);
        // ...and the accommodation is a wrapped line, not a second phantom.
        expect(gapPx).toBeLessThanOrEqual(TRANSCRIPT_MARKDOWN_LINE_PX);
        expect(rowBTopPx + MEASURED_ROW_B_PX).toBeGreaterThan(rowABottomPx);
    });

    it('keeps the estimate monotone in content past the old ceiling', () => {
        // A ceiling collapses every giant row onto one value, so the estimate carries no
        // information exactly where its error is largest. Two rows differing by ~400 wrapped
        // lines must not be handed to the renderer as the same position-bearing size.
        const tallerLines = GIANT_MARKDOWN_LINES + 400;
        const taller = estimateMessageRowPx('x'.repeat(ESTIMATE_CHARS_PER_LINE * tallerLines));
        const giant = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        expect(taller).toBeGreaterThan(giant);
        expect(taller).toBe(AGENT_ROW_CHROME_PX + (tallerLines * TRANSCRIPT_MARKDOWN_LINE_PX));
    });

    it('carries a giant turn body on the decomposed message row, not on a whole-turn estimate', () => {
        // `buildTranscriptTurnUnits` runs unconditionally in the pipeline, so a `turn` never
        // reaches `getEstimatedItemSize` — it arrives as its per-message rows. The whole-turn
        // shape is therefore handed back to the renderer, and the giant body is carried, unceiled,
        // by the message row the decomposition actually emits.
        const getMessageById = (messageId: string) => (
            messageId === 'a1' ? agentText('a1', 'x'.repeat(GIANT_MARKDOWN_CHARS)) : null
        );
        const wholeTurn = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById,
            item: {
                kind: 'turn',
                id: 't1',
                turn: {
                    id: 't1',
                    userMessageId: 'u1',
                    content: [{ kind: 'message', messageId: 'a1' }],
                },
            } as unknown as TranscriptRowShellItem,
        });
        expect(wholeTurn).toBeUndefined();

        const decomposedRow = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById,
            item: { kind: 'message', id: 'i-a1', messageId: 'a1' } as TranscriptRowShellItem,
        }) as number;
        expect(decomposedRow).toBeGreaterThan(CAPTURED_CEILING_PX);
        expect(decomposedRow).toBe(UNCEILED_ROW_A_ESTIMATE_PX);
    });

    it('DOES bound a giant pending-queue row — that row has its own painted ceiling', () => {
        // The C-1 no-ceiling rule is about rows whose painted height is unbounded. The pending
        // queue is not one: `PendingMessagesTranscriptBlock` renders its messages inside a
        // `ScrollView` carrying `maxHeight: transcriptPendingQueueMaxHeightPx` (default 80), so a
        // giant paste is SCROLLED inside a ~95px row, never painted at multi-thousand px. Modelling
        // it unbounded put a ~340px phantom gap under the tail row on every multi-message send
        // (J/D2, 2026-07-30); the measured painted heights live in
        // `estimateTranscriptRowHeightFromCache.pendingChrome.test.ts`.
        const estimate = estimateTranscriptRowHeightFromContent({
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: {
                kind: 'pending-queue',
                id: 'pending-queue',
                pendingMessages: [{
                    id: 'p1',
                    localId: null,
                    createdAt: 1,
                    updatedAt: 1,
                    text: 'x'.repeat(GIANT_MARKDOWN_CHARS),
                }, {
                    id: 'p2',
                    localId: null,
                    createdAt: 2,
                    updatedAt: 2,
                    text: 'another queued message',
                }],
                discardedMessages: [],
            } as unknown as TranscriptRowShellItem,
        }) as number;
        expect(estimate).toBeLessThan(200);
        expect(estimate).toBeGreaterThan(80);
    });
});
