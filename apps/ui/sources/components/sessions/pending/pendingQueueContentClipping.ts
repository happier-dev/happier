/**
 * How the transcript's pending block BOUNDS and SHAPES the messages it paints.
 *
 * This module is the SINGLE owner of those decisions. Two paths consume it and must not diverge:
 * `PendingMessagesTranscriptBlock` (what is painted) and `estimateTranscriptRowHeightFromCache`
 * (what Legend is told the unmeasured row is worth). Legend places rows by accumulation, so a
 * disagreement between them is a literal gap or overlap under the tail.
 *
 * ## Head vs backlog
 *
 * The message at the FRONT of the queue is the next one to be processed: it is about to be delivered
 * and replaced by its own committed bubble. Every message behind it is a backlog the reader is
 * parking, and a backlog must not eat the transcript it sits at the tail of.
 *
 * So the head is never line-clamped — it paints the same shape from enqueue through delivery to
 * commit — and only the rows behind it collapse. Two things follow from that, and both are the
 * point:
 *
 *  - A fully painted head bubble has a MEASURED height, which is what the committed row inherits
 *    across the crossover (`TranscriptMeasurementReconciler.recordPaintedUtteranceBubbleHeight`).
 *    A clamped bubble is not the height its committed twin will paint, so it cannot be carried —
 *    which is why clamping the head would put the send flicker back for exactly the queued case.
 *  - Sending a second message no longer collapses the first one under the reader's eyes.
 *
 * ## No DOWNWARD step at the crossover
 *
 * The block's non-bubble chrome must be no taller than the committed row's, or the swap moves the
 * bottom-pinned transcript DOWN — the motion this whole corridor exists to remove. Upward growth is
 * fine (it is what any arriving message does); downward is not.
 *
 *   pending, last row:  header 14.625 + scroll paddingTop 6 + gap 0            = 20.625
 *   committed:          `userMessageWrapper.paddingBottom` 22                  = 22.000
 *
 * so the committed row is 1.375px TALLER and the crossover can only move content UP. The gap under
 * a pending bubble exists to separate it from the row BELOW it, so the last row in the scroll
 * content paints none — which is what buys the 8px that used to make this step a 6.625px DOWN.
 *
 * PLATFORM CAVEAT, stated rather than papered over: that arithmetic holds on NATIVE. Web
 * additionally paints the in-flow action row under every pending bubble
 * (`paintsPendingMessageActionRow`, 20px), so its pending chrome is 40.625 against the committed
 * row's 22 and the web crossover still steps DOWN. Web has never shown the symptom — its renderer
 * corrects synchronously — so this is recorded as a known asymmetry to be closed with a MEASURED
 * web capture, not with a second derivation. The committed row's own action row is absolutely
 * positioned inside its 22px band (`MessageView.tsx` `MessageActionRow`), which is the shape the
 * pending block would have to adopt to close it.
 *
 * Device basis for all of it: `.project/reviews/2026-08-18-send-crossover-native/`.
 */
export type PendingQueueMessagePresentation = 'head' | 'backlog';

/** `contentContainerStyle.paddingTop` on the block's scroll box. */
export const PENDING_QUEUE_SCROLL_PADDING_TOP_PX = 6;
/** `userMessageBubble.paddingVertical` 8 x 2 — inside every pending bubble, head or backlog. */
export const PENDING_QUEUE_MESSAGE_BUBBLE_PADDING_PX = 16;
/** `userMessageWrapper.paddingBottom` — separates stacked rows. Zero under the last one. */
export const PENDING_QUEUE_MESSAGE_GAP_PX = 8;

/**
 * How many painted lines of the head are guaranteed visible before it scrolls.
 *
 * A product number, not a measurement: the point at which a queued utterance stops reading as "the
 * thing I just typed" and starts eating the transcript under it.
 */
export const PENDING_QUEUE_HEAD_MAX_LINES = 6;

/** The head is the next message to be processed; everything behind it is backlog. */
export function resolvePendingQueueMessagePresentation(index: number): PendingQueueMessagePresentation {
    return index === 0 ? 'head' : 'backlog';
}

/**
 * Does the block CLAMP this message's text to `transcriptPendingMessageCollapsedLines`?
 *
 * Only a backlog row. The head is scrolled inside the block's bound, never truncated, so its
 * `onLayout` reports the full painted height the committed row inherits.
 */
export function clampsPendingMessageLines(presentation: PendingQueueMessagePresentation): boolean {
    return presentation === 'backlog';
}

/** `userMessageWrapper.paddingBottom` for one pending row: separation only when a row follows it. */
export function resolvePendingMessageGapPx(params: Readonly<{ isLastInScrollContent: boolean }>): number {
    return params.isLastInScrollContent ? 0 : PENDING_QUEUE_MESSAGE_GAP_PX;
}

/** The head's own bound: {@link PENDING_QUEUE_HEAD_MAX_LINES} painted lines plus its bubble padding. */
export function resolvePendingQueueHeadMaxHeightPx(lineHeightPx: number): number {
    return PENDING_QUEUE_SCROLL_PADDING_TOP_PX
        + PENDING_QUEUE_MESSAGE_BUBBLE_PADDING_PX
        + PENDING_QUEUE_HEAD_MAX_LINES * lineHeightPx;
}

/**
 * The scroll box's painted `maxHeight`.
 *
 * A lone utterance gets exactly the head bound. A real queue gets the head bound PLUS the compact
 * account bound (`transcriptPendingQueueMaxHeightPx`), so the head stays fully visible and the
 * collapsed backlog scrolls in the strip beneath it rather than pushing the head out of view.
 */
export function resolvePendingQueueScrollMaxHeightPx(params: Readonly<{
    pendingCount: number;
    discardedCount: number;
    queueMaxHeightPx: number;
    lineHeightPx: number;
}>): number {
    const headMaxHeightPx = resolvePendingQueueHeadMaxHeightPx(params.lineHeightPx);
    const isSoleUtterance = params.pendingCount === 1 && params.discardedCount === 0;
    return isSoleUtterance ? headMaxHeightPx : headMaxHeightPx + params.queueMaxHeightPx;
}
