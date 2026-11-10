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
 *   pending, last row:  top inset 16 + scroll paddingTop 6 + gap 0             = 22.000
 *   committed:          `userMessageWrapper.paddingBottom` 22                  = 22.000
 *
 * so the crossover does not step at all. (The titled "Pending messages (N)" header is drawn INSIDE this
 * inset, so restoring it (owner 11-10) adds no height; 0.2 stacked it above, a 14.625px band.) The gap under
 * a pending bubble exists to separate it from the row BELOW it, so the last row in the scroll
 * content paints none — which is what buys the 8px that used to make this step a 6.625px DOWN.
 *
 * PLATFORM CAVEAT, stated rather than papered over: that arithmetic holds on NATIVE. Web
 * additionally paints the in-flow action row under every pending bubble
 * (`paintsPendingMessageActionRow`, 22px), so its pending chrome is 44 against the committed
 * row's 22 and the web crossover still steps DOWN. Web has never shown the symptom — its renderer
 * corrects synchronously — so this is recorded as a known asymmetry to be closed with a MEASURED
 * web capture, not with a second derivation. The committed row's own action row is absolutely
 * positioned inside its 22px band (`MessageView.tsx` `MessageActionRow`), which is the shape the
 * pending block would have to adopt to close it.
 *
 * Device basis: measured on the sibling preview repo (iPhone 17 Pro / iOS 26.5, 2026-08-18) against
 * geometry that is byte-identical here — every constant below is re-derived from THIS repo's styles.
 */
import { HAPPIER_PAGE_METRICS, HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_SPACE_STEPS } from '@happier-dev/plugin-ui/environment';
import type { PendingMessagePresentation } from './pendingMessageVisualState';

export type PendingQueueMessagePresentation = 'head' | 'backlog';

/**
 * The space above the queue. With the scroll box's padding it equals the committed row's 22px
 * (see "No DOWNWARD step" above); the queue's titled header is drawn inside it.
 */
export const PENDING_QUEUE_TOP_INSET_PX = 16;
/** `contentContainerStyle.paddingTop` on the block's scroll box. */
export const PENDING_QUEUE_SCROLL_PADDING_TOP_PX = 6;
/** `userMessageBubble.paddingVertical` 8 x 2 — inside every pending bubble, head or backlog. */
export const PENDING_QUEUE_MESSAGE_BUBBLE_PADDING_PX = 16;
/** `userMessageWrapper.paddingBottom` — separates stacked rows. Zero under the last one. */
export const PENDING_QUEUE_MESSAGE_GAP_PX = 8;
/** The drawn 18 px actions plus the band's 4 px top margin (`PendingMessagesTranscriptBlock` `messageActionContainer`). */
export const PENDING_MESSAGE_ACTION_ROW_HEIGHT_PX = 22;

/** Shared with the renderer; callers with a theme retain its density-specific spacing. */
export function resolvePendingFollowNoticePullUpPx(space: Readonly<{ s16: number }> = HAPPIER_SPACE_STEPS): number {
    return space.s16;
}

export function estimatePendingFollowNoticeBodyHeightPx(needsYou: boolean): number {
    return HAPPIER_TYPE_SCALE.label.lineHeight + 22
        + (needsYou ? HAPPIER_TYPE_SCALE.meta.lineHeight + 2 : 0);
}

/** Source-derived notice geometry, shared by the scroll box's initial size and the list estimate.
 * TranscriptEventRow has 22px below its label; attention adds a meta line and s2. The status band
 * pulls up by s16, so the delivery band (a blocked reason included, on its one line) reads under the
 * notice's own words; its source action uses RoundButton small.
 * The estimate assumes one source-label line; natural onLayout owns actual localized wrapping.
 */
export function estimatePendingFollowNoticeHeightPx(
    row: Pick<PendingMessagePresentation, 'needsYou' | 'opensSourceSession' | 'canMutate' | 'canReorder'>,
    platformIsWeb: boolean,
    queueCanReorder: boolean,
): number {
    const actionBand = row.canMutate && (platformIsWeb || (queueCanReorder && row.canReorder)) ? PENDING_MESSAGE_ACTION_ROW_HEIGHT_PX : 0;
    return estimatePendingFollowNoticeBodyHeightPx(row.needsYou)
        - resolvePendingFollowNoticePullUpPx()
        + Math.max(HAPPIER_TYPE_SCALE.meta.lineHeight, actionBand,
            row.opensSourceSession ? HAPPIER_PAGE_METRICS.smallControlHeightPx : 0);
}

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
