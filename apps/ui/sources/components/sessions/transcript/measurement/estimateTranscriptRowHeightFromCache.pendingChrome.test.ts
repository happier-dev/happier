import { describe, expect, it } from 'vitest';

import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import { estimateTranscriptRowHeightFromContent } from './estimateTranscriptRowHeightFromCache';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * The height ONE short queued message paints on native: header 14.625 + [ scroll paddingTop 6 +
 * bubble paddingVertical 16 + one 24px line ], and NO inter-row gap because it is the last row in
 * the scroll content.
 *
 * The 2026-07-30 device measurement of this shape was 68.625 — it included the 8px
 * `userMessageWrapper.paddingBottom`. That gap is separation from the row BELOW, and carrying it
 * under the last row is what made the crossover a 6.625px DOWNWARD step; dropping it there leaves
 * the committed row 1.375px taller, so the swap can only move content UP
 * (`pendingQueueContentClipping`, and `.project/reviews/2026-08-18-send-crossover-native/`).
 *
 * No action row either: the block paints that branch as `isWeb ? … : canReorder ? … : null`, and a
 * LONE pending message on native — the shape every send creates — takes neither branch.
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
/** `contentContainerStyle.paddingTop` + `userMessageBubble.paddingVertical` ×2, no trailing gap. */
const PENDING_QUEUE_ONE_MESSAGE_CHROME_PX = 6 + 16;
/** `transcriptMarkdownTextStyle.lineHeight` — the typography the committed bubble also paints. */
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
        discardedReason: null,
        ...overrides,
    } as DiscardedPendingMessage;
}

function estimatePendingQueue(
    pendingMessages: PendingMessage[],
    discardedMessages: DiscardedPendingMessage[] = [],
    platformIsWeb = false,
): number | undefined {
    return estimateTranscriptRowHeightFromContent({
        toolCallsGroupChromeVariant: 'feed_background',
        getMessageById: () => null,
        platformIsWeb,
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
    it('matches the measured painted height of a single short queued message on native', () => {
        expect(estimatePendingQueue([pendingMessage({ text: 'ok' })]))
            .toBeCloseTo(ONE_SHORT_PENDING_MESSAGE_NATIVE_PX, 1);
    });

    /**
     * The 20px the estimate used to add on EVERY platform. `PendingMessagesTranscriptBlock` paints
     * the in-flow action row as `isWeb ? <copy/send> : canReorder ? <drag handle> : null`, so it is
     * unconditional on web and unreachable for a lone native pending message. Modelling it
     * unconditionally put a 20px gap under the tail on every native send; this pair is what stops
     * either side of that predicate from drifting again.
     */
    it('adds the in-flow action row on web, where the block paints it unconditionally', () => {
        expect(estimatePendingQueue([pendingMessage({ text: 'ok' })], [], true))
            .toBeCloseTo(ONE_SHORT_PENDING_MESSAGE_NATIVE_PX + PENDING_MESSAGE_ACTION_ROW_PX, 1);
    });

    it('never exceeds the block header plus its own scroll cap, however long the QUEUE is', () => {
        const bounded = PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_CAP_PX;

        // Two long messages: the old model returned ~340px for a block that paints ~95px.
        expect(estimatePendingQueue([
            pendingMessage({ id: 'p1', text: 'a'.repeat(300) }),
            pendingMessage({ id: 'p2', text: 'b'.repeat(300) }),
        ])).toBeCloseTo(bounded, 1);
        // Three long messages: the old model returned ~438px — a ~340px phantom gap at the tail.
        expect(estimatePendingQueue([
            pendingMessage({ id: 'p1', text: 'a'.repeat(300) }),
            pendingMessage({ id: 'p2', text: 'b'.repeat(300) }),
            pendingMessage({ id: 'p3', text: 'c'.repeat(300) }),
        ])).toBeCloseTo(bounded, 1);
    });

    /**
     * D (2026-08-01). The SEND crossover: `pending-queue` holding exactly one utterance is the row
     * that is about to be replaced by that utterance's committed bubble. Capping it at the queue's
     * compact bound made the handover a measured +136px height jump (94.25 → 230 for a 258-char
     * message, `.project/reviews/2026-08-01-send-transition/M-send-transition.md` §6), and this
     * estimate is a POSITION, so it has to agree with the block or it manufactures the same error
     * from the other side.
     */
    it('sizes a single queued utterance from its own content, not the compact queue scroll cap', () => {
        // 300 chars ⇒ ceil(300/72) = 5 rendered lines: over the compact cap, under the lone bound.
        const natural = PENDING_QUEUE_HEADER_PX
            + PENDING_QUEUE_ONE_MESSAGE_CHROME_PX
            + Math.ceil(300 / ESTIMATE_CHARS_PER_LINE) * TRANSCRIPT_MARKDOWN_LINE_PX;

        expect(natural).toBeGreaterThan(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_BACKLOG_STRIP_PX);
        expect(estimatePendingQueue([pendingMessage({ text: 'x'.repeat(300) })])).toBeCloseTo(natural, 1);
    });

    /**
     * ...but it is still BOUNDED. An unbounded lone message painted ~1.1k px for a 2000-char send.
     * The bound is high enough that a short or medium send is painted in full — which is what keeps
     * the crossover motionless now that the committed row inherits this row's measured bubble.
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
    });

    it('adds the terminal-draft notice, which the block paints OUTSIDE the capped scroll box', () => {
        const blocked = estimatePendingQueue([pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'terminal_composer_draft',
        })]) as number;

        expect(blocked).toBeGreaterThan(PENDING_QUEUE_HEADER_PX + PENDING_QUEUE_BACKLOG_STRIP_PX);
    });
});
