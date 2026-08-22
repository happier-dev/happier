import { describe, expect, it } from 'vitest';

import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * The height ONE short queued message paints on native: header 14.625 + [ scroll paddingTop 6 +
 * bubble paddingVertical 16 + one 24px line ], NO inter-row gap (it is the last row in the scroll
 * content) and NO action row (native paints that branch only for a reorderable queue).
 *
 * The gap under the last row is separation from a row that is not there, and carrying it made the
 * pending→committed crossover a DOWNWARD step; dropping it leaves the committed row 1.375px taller,
 * so the swap can only move content UP. See `pendingQueueContentClipping`.
 */
const ONE_SHORT_PENDING_MESSAGE_NATIVE_PX = 60.625;
/** The same row on web, which paints the copy/send action row unconditionally. */
const PENDING_MESSAGE_ACTION_ROW_PX = 20;
/** `transcriptPendingQueueMaxHeightPx` account default: the compact BACKLOG strip. */
const PENDING_QUEUE_BACKLOG_STRIP_PX = 80;
/** `resolvePendingQueueHeadMaxHeightPx(24)` — six painted lines plus the bubble's own padding. */
const PENDING_QUEUE_HEAD_CAP_PX = 6 + 16 + 6 * 24;
/** A queue keeps the head fully visible and scrolls the collapsed backlog beneath it. */
const PENDING_QUEUE_CAP_PX = PENDING_QUEUE_HEAD_CAP_PX + PENDING_QUEUE_BACKLOG_STRIP_PX;
const PENDING_QUEUE_HEADER_PX = 14.625;
const PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX = 31;
const PENDING_QUEUE_ONE_MESSAGE_CHROME_PX = 6 + 16;
const TRANSCRIPT_MARKDOWN_LINE_PX = 24;
/** `ESTIMATE_CHARS_PER_LINE` — the estimator's flat, width-blind wrap. */
const ESTIMATE_CHARS_PER_LINE = 72;

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'l1',
        createdAt: 1,
        updatedAt: 1,
        source: 'local_outbound',
        text: 'ok',
        rawRecord: null,
        ...overrides,
    } as PendingMessage;
}

function discardedMessage(overrides: Partial<DiscardedPendingMessage> = {}): DiscardedPendingMessage {
    return {
        ...pendingMessage({ id: 'd1', localId: 'ld1' }),
        discardedAt: 2,
        ...overrides,
    } as DiscardedPendingMessage;
}

function estimatePendingQueue(
    pendingMessages: PendingMessage[],
    discardedMessages: DiscardedPendingMessage[] = [],
    platformIsWeb = false,
): number | undefined {
    return estimateTranscriptRowHeightFromContent({
        platformIsWeb,
        toolCallsGroupChromeVariant: 'feed_background',
        getMessageById: () => null,
        item: {
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages,
            discardedMessages,
        } satisfies TranscriptRowShellItem,
    });
}

/**
 * J/D2 (2026-07-30). Legend places rows by ACCUMULATION, so this estimate is a POSITION: an
 * undershoot is a literal overlap and an overshoot a literal gap. The previous model summed a text
 * heuristic over every queued message — the height of the block's SCROLL CONTENT, not of the row —
 * so it undershot the one shape that was measured live and overshot everything else without bound.
 */
describe('pending-queue estimate is chrome-aware', () => {
    it('matches the measured painted height of a single short queued message', () => {
        expect(estimatePendingQueue([pendingMessage({ text: 'ok' })]))
            .toBeCloseTo(ONE_SHORT_PENDING_MESSAGE_NATIVE_PX, 1);
    });

    it('never exceeds the block header plus its own scroll cap, however long the queue is', () => {
        const bounded = PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_CAP_PX;

        expect(estimatePendingQueue([
            pendingMessage({ id: 'p1', text: 'a'.repeat(300) }),
            pendingMessage({ id: 'p2', text: 'b'.repeat(300) }),
        ])).toBeCloseTo(bounded, 1);
        expect(estimatePendingQueue([
            pendingMessage({ id: 'p1', text: 'a'.repeat(300) }),
            pendingMessage({ id: 'p2', text: 'b'.repeat(300) }),
            pendingMessage({ id: 'p3', text: 'c'.repeat(300) }),
        ])).toBeCloseTo(bounded, 1);
    });

    it('sizes a single queued utterance from its own content, not the compact backlog strip', () => {
        // 300 chars ⇒ ceil(300/72) = 5 rendered lines: over the compact strip, under the head cap.
        const natural = PENDING_QUEUE_HEADER_PX
            + PENDING_QUEUE_ONE_MESSAGE_CHROME_PX
            + Math.ceil(300 / ESTIMATE_CHARS_PER_LINE) * TRANSCRIPT_MARKDOWN_LINE_PX;

        expect(natural).toBeGreaterThan(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_BACKLOG_STRIP_PX);
        expect(estimatePendingQueue([pendingMessage({ text: 'x'.repeat(300) })])).toBeCloseTo(natural, 1);
    });

    /**
     * ...but it is still BOUNDED. An unbounded lone message painted ~1.1k px for a 2000-char send,
     * with the "View more" affordance and the header chevron both unreachable for it.
     */
    it('bounds a very long lone utterance at the head cap', () => {
        expect(estimatePendingQueue([pendingMessage({ text: 'x'.repeat(4000) })]))
            .toBeCloseTo(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_HEAD_CAP_PX, 1);
    });

    it('grows monotonically with the queue up to that bound', () => {
        const one = estimatePendingQueue([pendingMessage()]) as number;
        const two = estimatePendingQueue([
            pendingMessage({ id: 'p1' }),
            pendingMessage({ id: 'p2' }),
        ]) as number;

        expect(two).toBeGreaterThan(one);
        expect(two).toBeLessThanOrEqual(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_CAP_PX);
    });

    it('sizes a message from the string the row renders (displayText)', () => {
        const displayed = estimatePendingQueue([pendingMessage({ text: 'hi', displayText: 'z'.repeat(600) })]) as number;
        const stored = estimatePendingQueue([pendingMessage({ text: 'hi' })]) as number;

        expect(displayed).toBeGreaterThan(stored);
    });

    it('accounts for the two-line header the block paints when queued and discarded rows coexist', () => {
        const both = estimatePendingQueue([pendingMessage()], [discardedMessage()]) as number;
        const discardedOnly = estimatePendingQueue([], [discardedMessage()]) as number;

        expect(both).toBeLessThanOrEqual(PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX + PENDING_QUEUE_CAP_PX);
        expect(discardedOnly).toBeLessThanOrEqual(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_CAP_PX);
        expect(both).toBeGreaterThan(discardedOnly);
    });

    /**
     * F-P2 (2026-08-10): this repository's block paints NO send-failed notice — the failed state
     * selects only the absolutely-positioned status chip, and its retry affordance lives in the
     * constant-height web action row. The estimate modelled a 36px notice that is never painted, so
     * every failed row was placed 36px too low.
     */
    it('models no extra chrome for a send-failed row, which paints none', () => {
        const saving = estimatePendingQueue([pendingMessage({ text: 'ok' })]) as number;
        const failed = estimatePendingQueue([pendingMessage({ text: 'ok', sendState: 'failed' })]) as number;

        expect(failed).toBeCloseTo(saving, 1);
    });

    it('adds the per-message notice a blocked delivery paints inside the scroll box', () => {
        const queued = estimatePendingQueue([pendingMessage({ source: 'server_pending' })]) as number;
        const blocked = estimatePendingQueue([pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'terminal_composer_draft',
        })]) as number;

        expect(blocked).toBeGreaterThan(queued);
    });
});
