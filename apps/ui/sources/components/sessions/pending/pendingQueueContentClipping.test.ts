import { describe, expect, it } from 'vitest';

import {
    PENDING_QUEUE_HEAD_MAX_LINES,
    PENDING_QUEUE_MESSAGE_GAP_PX,
    clampsPendingMessageLines,
    resolvePendingMessageGapPx,
    resolvePendingQueueHeadMaxHeightPx,
    resolvePendingQueueMessagePresentation,
    resolvePendingQueueScrollMaxHeightPx,
} from './pendingQueueContentClipping';

const QUEUE_MAX_HEIGHT_PX = 80;
/** `transcriptMarkdownTextStyle.lineHeight` — the typography every one of these rows paints. */
const LINE_PX = 24;
/** `userMessageWrapper.paddingBottom` 22 — the committed row's only non-bubble chrome. */
const COMMITTED_NON_BUBBLE_PX = 22;
/** The block's own header row, above the scroll box. */
const PENDING_HEADER_PX = 14.625;

describe('pending queue message presentation', () => {
    it('treats the front of the queue as the head and everything behind it as backlog', () => {
        expect(resolvePendingQueueMessagePresentation(0)).toBe('head');
        expect(resolvePendingQueueMessagePresentation(1)).toBe('backlog');
        expect(resolvePendingQueueMessagePresentation(7)).toBe('backlog');
    });

    /**
     * The head is the message about to be delivered and replaced by its own committed bubble. It is
     * never truncated, for two reasons that are the same reason: sending a second message must not
     * collapse the first under the reader's eyes, and only a FULLY painted bubble reports the height
     * the committed row inherits across the crossover
     * (`TranscriptMeasurementReconciler.recordPaintedUtteranceBubbleHeight`).
     */
    it('line-clamps only the backlog, never the head', () => {
        expect(clampsPendingMessageLines('head')).toBe(false);
        expect(clampsPendingMessageLines('backlog')).toBe(true);
    });
});

describe('pending queue geometry', () => {
    /**
     * THE crossover invariant: the block's non-bubble chrome must be no taller than the committed
     * row's, or the swap moves the bottom-pinned transcript DOWN. Upward growth is fine — it is what
     * any arriving message does. Downward is the motion this corridor exists to remove.
     */
    it('never leaves the pending block taller than the committed row around the same bubble', () => {
        const pendingNonBubblePx = PENDING_HEADER_PX
            + resolvePendingQueueHeadMaxHeightPx(LINE_PX)
            - (PENDING_QUEUE_HEAD_MAX_LINES * LINE_PX)
            - 16 // the bubble's own paddingVertical, which the committed row also paints
            + resolvePendingMessageGapPx({ isLastInScrollContent: true });

        expect(pendingNonBubblePx).toBeLessThanOrEqual(COMMITTED_NON_BUBBLE_PX);
    });

    it('drops the inter-row gap under the last row and keeps it everywhere else', () => {
        expect(resolvePendingMessageGapPx({ isLastInScrollContent: true })).toBe(0);
        expect(resolvePendingMessageGapPx({ isLastInScrollContent: false })).toBe(PENDING_QUEUE_MESSAGE_GAP_PX);
    });

    it('guarantees the head six painted lines before it scrolls', () => {
        // scroll paddingTop 6 + bubble paddingVertical 16 + 6 lines.
        expect(resolvePendingQueueHeadMaxHeightPx(LINE_PX)).toBe(6 + 16 + 6 * LINE_PX);
        expect(PENDING_QUEUE_HEAD_MAX_LINES).toBe(6);
    });

    it('bounds a lone utterance at exactly the head bound', () => {
        expect(resolvePendingQueueScrollMaxHeightPx({
            pendingCount: 1,
            discardedCount: 0,
            queueMaxHeightPx: QUEUE_MAX_HEIGHT_PX,
            lineHeightPx: LINE_PX,
        })).toBe(resolvePendingQueueHeadMaxHeightPx(LINE_PX));
    });

    /**
     * A real queue keeps the head fully visible and gives the collapsed backlog the compact account
     * bound beneath it. Bounding the whole block at the compact bound instead is what used to push
     * the head out of view the moment a second message arrived.
     */
    it('gives a queue the head bound PLUS the compact backlog strip', () => {
        const queue = resolvePendingQueueScrollMaxHeightPx({
            pendingCount: 3,
            discardedCount: 0,
            queueMaxHeightPx: QUEUE_MAX_HEIGHT_PX,
            lineHeightPx: LINE_PX,
        });

        expect(queue).toBe(resolvePendingQueueHeadMaxHeightPx(LINE_PX) + QUEUE_MAX_HEIGHT_PX);
        expect(queue).toBeGreaterThan(resolvePendingQueueHeadMaxHeightPx(LINE_PX));
    });

    it('treats a lone tombstone, and one queued row beside one, as a queue', () => {
        const head = resolvePendingQueueHeadMaxHeightPx(LINE_PX);
        for (const counts of [{ pendingCount: 1, discardedCount: 1 }, { pendingCount: 0, discardedCount: 1 }]) {
            expect(resolvePendingQueueScrollMaxHeightPx({
                ...counts,
                queueMaxHeightPx: QUEUE_MAX_HEIGHT_PX,
                lineHeightPx: LINE_PX,
            })).toBe(head + QUEUE_MAX_HEIGHT_PX);
        }
    });
});
