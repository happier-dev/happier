import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * F1 (2026-08-10) · the committed text row is sized by the chrome it actually paints.
 *
 * Legend places rows by ACCUMULATION and answers a size CHANGE with an MVCP scroll adjust, so a
 * wrong estimate is not a margin — it is visible motion. On every send the tail swaps the
 * `pending-queue` row for the new committed user row, Legend takes this estimate for the committed
 * row, and then the row's own onLayout replaces it. Both of those are scroll adjusts.
 *
 * MEASURED on device IN THE SIBLING REPO (iOS simulator, rAF sampler on the mounted LegendList
 * fiber, trace batch 2026-08-09): a one-line committed USER row paints **62.0px** (12/12 and 10/10
 * trials) and a one-line AGENT reply paints **46px** (10/10). The estimator answered **54** for
 * BOTH — 8px under for the user row and 8px over for the agent row — producing
 * `requestAdjust(-14.2)` at the handover and a compensating `requestAdjust(+8)` after the bubble
 * already looked settled.
 *
 * Those totals are DERIVED here rather than re-measured, and they transfer because every term
 * below is byte-identical in THIS repo's `MessageView` (verified 2026-08-10). Each decomposes
 * exactly against the styles that produce it, which is what pins the two bases to source rather
 * than to a calibration:
 *
 *   user  = `userMessageWrapper.paddingBottom` 22 + `userMessageBubble.paddingVertical` 8x2
 *           + `transcriptMarkdownTextStyle.lineHeight` 24                            = 62.0  OK
 *   agent = `agentMessageContainer.paddingBottom` 22 + the same 24px line             = 46.0  OK
 *
 * (no markdown block margin in either: the transcript renderer passes
 * `allowTrailingMargin={false}` and the transcript paragraph style carries `marginTop: 0`.)
 *
 * The two shapes differ by exactly the user bubble's own padding, so a SINGLE shared base cannot
 * be right for both — which is the property the last case below pins.
 */

/** Sibling-repo device measurement (2026-08-09), DERIVED here from this repo's identical styles. */
const MEASURED_ONE_LINE_USER_ROW_PX = 62;
/** Same basis: sibling-repo measurement, derived here from this repo's `agentMessageContainer`. */
const MEASURED_ONE_LINE_AGENT_ROW_PX = 46;
/** `transcriptMarkdownTextStyle.lineHeight` — the typography both committed shapes paint. */
const TRANSCRIPT_MARKDOWN_LINE_PX = 24;
/** `userMessageBubble.paddingVertical` 8 x 2 — the only chrome the user row has and the agent row does not. */
const USER_BUBBLE_PADDING_PX = 16;

function textMessage(kind: 'user-text' | 'agent-text', text: string): Message {
    return {
        kind,
        id: 'm1',
        localId: null,
        createdAt: 1,
        text,
    } as Message;
}

/** `n` wrapped lines with no markdown blocks: the estimator counts newlines plus wrapped chars. */
function textOfLines(lineCount: number): string {
    return Array.from({ length: lineCount }, () => 'x').join('\n');
}

function estimateTextRowPx(kind: 'user-text' | 'agent-text', lineCount: number): number {
    const estimate = estimateTranscriptRowHeightFromContent({
        platformIsWeb: false,
        toolCallsGroupChromeVariant: 'feed_background',
        getMessageById: () => textMessage(kind, textOfLines(lineCount)),
        item: { kind: 'message', id: 'i1', messageId: 'm1' } as TranscriptRowShellItem,
    });
    expect(estimate).toBeTypeOf('number');
    return estimate as number;
}

describe('estimateTranscriptRowHeightFromContent · committed text row chrome', () => {
    it('sizes a one-line committed user row at the height it paints', () => {
        expect(estimateTextRowPx('user-text', 1)).toBe(MEASURED_ONE_LINE_USER_ROW_PX);
    });

    it('sizes a one-line committed agent row at the height it paints', () => {
        expect(estimateTextRowPx('agent-text', 1)).toBe(MEASURED_ONE_LINE_AGENT_ROW_PX);
    });

    it('grows both committed shapes by one transcript markdown line per wrapped line', () => {
        // Kills a per-kind base that keeps the old 22px line: the bases would be right at one line
        // and drift 2px per line after it, and a long turn is where accumulation error compounds.
        for (const kind of ['user-text', 'agent-text'] as const) {
            const oneLine = estimateTextRowPx(kind, 1);
            expect(estimateTextRowPx(kind, 2) - oneLine).toBe(TRANSCRIPT_MARKDOWN_LINE_PX);
            expect(estimateTextRowPx(kind, 5) - oneLine).toBe(4 * TRANSCRIPT_MARKDOWN_LINE_PX);
        }
    });

    it('keeps the user row taller than the agent row by exactly the bubble padding', () => {
        // Kills a single global base tuned to the user row: that fixes the send and re-breaks every
        // agent reply by the same 8px, in the opposite (overshoot//gap) direction. The two shapes
        // are separated by the bubble the agent reply does not paint, at every line count.
        for (const lineCount of [1, 3, 12]) {
            expect(estimateTextRowPx('user-text', lineCount) - estimateTextRowPx('agent-text', lineCount))
                .toBe(USER_BUBBLE_PADDING_PX);
        }
    });
});
