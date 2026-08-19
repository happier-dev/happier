import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * C-1 — a size estimate is a POSITION, so it may not carry a ceiling.
 *
 * Live web capture 2026-07-28, session `cmrxjkh2v0vintmk4445ywy9s`, measured while the defect was
 * on screen (a "Turn Diff" row painted ON TOP OF the message above it):
 *
 * ```
 * row A  transcript-item-msg:8y606ubqcvm  top =  2285   height = 21849 (DOM height matches)
 * row B  transcript-item-msg:xocdt74v8li  top = 22285   height =    50 (DOM height matches)
 * container innerH = 22341 | scrollHeight = 24146 | tail after the last row = 1811px
 * ```
 *
 * Both boxes matched their DOM heights exactly, so every HEIGHT was right and only B's POSITION
 * was wrong. The arithmetic names the owner: `B.top 22285 = A.top 2285 + 20000`, while A's real
 * height is 21849, and `21849 - 20000 = 1849` is exactly the measured overlap. 20000 is this
 * module's own `ESTIMATE_MAX_ROW_PX`.
 *
 * The module doc for the tool-group constants already states the principle for the OVER-estimate
 * direction: "Legend places rows by ACCUMULATION, so an estimate that overshoots a row's painted
 * height is not a harmless margin — it is a literal gap under that row." This is that sentence
 * inverted. An estimate that UNDERSHOOTS is a literal OVERLAP, and a ceiling guarantees undershoot
 * for every row taller than it. A 21,849px markdown message is legitimate content, so the ceiling
 * cannot be defended as a guard against absurd input — the layout has to accommodate the real height.
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
     * below is a FIXTURE derived from the estimator's own text flow — 72 chars per wrapped line —
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
        platformIsWeb: false,
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
        // Legend accumulates: `positions[i + 1] = positions[i] + size_i`, and `size_i` is what this
        // owner hands `getEstimatedItemSize` for a row it has not measured yet.
        const rowAEstimatePx = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        const rowBTopPx = ROW_A_TOP_PX + rowAEstimatePx;
        const rowABottomPx = ROW_A_TOP_PX + MEASURED_ROW_A_PX;
        // Negative is overlap. The capture measured -1849; a healthy transcript is >= 0.
        const gapPx = rowBTopPx - rowABottomPx;

        expect(rowBTopPx).not.toBe(CAPTURED_ROW_B_TOP_PX);
        expect(gapPx).toBeGreaterThanOrEqual(0);
        // ...and the accommodation is a wrapped line, not a second phantom: the 1811px tail in the
        // capture was this same 1849px error re-surfacing below the last row.
        expect(gapPx).toBeLessThanOrEqual(TRANSCRIPT_MARKDOWN_LINE_PX);
        expect(rowBTopPx + MEASURED_ROW_B_PX).toBeGreaterThan(rowABottomPx);
    });

    it('keeps the estimate monotone in content past the old ceiling', () => {
        // A ceiling collapses every giant row onto one value, so the estimate carries no
        // information exactly where its error is largest. Two rows that differ by ~400 wrapped
        // lines must not be handed the renderer as the same position-bearing size.
        const tallerLines = GIANT_MARKDOWN_LINES + 400;
        const taller = estimateMessageRowPx('x'.repeat(ESTIMATE_CHARS_PER_LINE * tallerLines));
        const giant = estimateMessageRowPx('x'.repeat(GIANT_MARKDOWN_CHARS));
        expect(taller).toBeGreaterThan(giant);
        expect(taller).toBe(AGENT_ROW_CHROME_PX + (tallerLines * TRANSCRIPT_MARKDOWN_LINE_PX));
    });

    // The other formerly unbounded shape — a single row holding a whole EXPANDED tool group — no
    // longer exists at this boundary: `buildTranscriptTurnUnits` runs unconditionally in the
    // pipeline and decomposes every group into per-unit rows, each of which is one measured cap,
    // so no group-shaped row can reach an accumulation ceiling here.
    it('never sees a whole tool group as one row, so no group can reach a ceiling', () => {
        const estimate = estimateTranscriptRowHeightFromContent({
            platformIsWeb: false,
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: {
                kind: 'tool-calls-group',
                id: 'g1',
                toolMessageIds: Array.from({ length: 1_200 }, (_value, index) => `t${index}`),
                createdAt: 1,
            } as TranscriptRowShellItem,
        });
        expect(estimate).toBeUndefined();
        // One decomposed unit row is a measured cap, orders of magnitude below the former ceiling.
        const unitRowPx = estimateTranscriptRowHeightFromContent({
        platformIsWeb: false,
            toolCallsGroupChromeVariant: 'feed_background',
            getMessageById: () => null,
            item: {
                kind: 'tool-group-tool',
                id: 'g1#t0',
                groupId: 'g1',
                toolMessageId: 't0',
                createdAt: 1,
            } as unknown as TranscriptRowShellItem,
        });
        expect(unitRowPx).toBe(28);
        expect(unitRowPx).toBeLessThan(CAPTURED_CEILING_PX);
    });
});
