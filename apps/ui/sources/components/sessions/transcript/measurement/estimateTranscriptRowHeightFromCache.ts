import {
    getPendingMessageVisualState,
    isPendingMessageProviderEffectPossible,
    paintsPendingMessageActionRow,
    resolvePendingMessageHeightBearingChrome,
} from '@/components/sessions/pending/pendingMessageVisualState';
import {
    PENDING_QUEUE_MESSAGE_BUBBLE_PADDING_PX,
    PENDING_QUEUE_SCROLL_PADDING_TOP_PX,
    resolvePendingMessageGapPx,
    resolvePendingQueueScrollMaxHeightPx,
} from '@/components/sessions/pending/pendingQueueContentClipping';
import { resolveTranscriptUtteranceIdentity } from '@/components/sessions/transcript/motion/transcriptFreshnessGate';
import { resolveMessageStructuredReferences } from '@/components/sessions/transcript/references/messageStructuredReferences';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { findStructuredMessageRenderer } from '@/components/sessions/transcript/structured/structuredMessageRegistry';
import { parseSessionMediaMessageMeta } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
// Type-only: the chrome variant is DECIDED by `resolveToolCallsGroupChromeVariant` in that module
// (the renderer's own owner) and threaded in by `ChatListInternal`. This estimate consumes the
// decision; it never re-derives one from the underlying settings.
import type { ToolCallsGroupChromeVariant } from '@/components/sessions/transcript/toolCalls/units/toolCallsGroupChrome';

import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import {
    TRANSCRIPT_GROWING_ROW_STATES,
    type TranscriptMeasurementReconciler,
} from './transcriptMeasurementReconciler';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

/**
 * Size ESTIMATE served to the list renderer's virtualization layer for rows it has
 * not yet measured (Legend `getEstimatedItemSize`, vendored @legendapp/list 3.3.3
 * patch): the app's own measured-height cache is the best predictor of a row's real
 * height — a prior EXACT measurement beats Legend's per-type average learning,
 * which is biased toward whichever rows rendered first (LegendApp/legend-list#492;
 * live scrollHeight-oscillation captures 2026-07-22/23: switch-back/reopen jiggle).
 * Unknown rows fall through (undefined) to Legend's per-type average / scalar estimate.
 *
 * A GROWING row's floor (`streaming`, `thinking`) is NOT a size: the reconciler
 * deliberately carries that floor across content shapes, so it is a lower bound on a
 * row whose content is still arriving, and the content estimate below tracks the live
 * text better. Every other row state is shrink-capable, and for those this estimate is
 * the row's own last measurement at this width/font — a real measurement, not a
 * prediction. It cannot come from the exact-height cache alone, because that cache is
 * stable-only and a row that never reaches `stable` (every `pending-action` row:
 * `pending-queue`, `pending-user-action`, `action-draft`, and every `tool-progress`
 * row) structurally cannot enter it.
 *
 * W-1: an estimate and a reservation are OPPOSITE contracts over that same measurement
 * and must not be read through one call. A reservation is a forcing, self-fulfilling
 * `minHeight` style, so it is released the instant a shrink-capable row's shape moves
 * (`isFloorShapeValid`) — otherwise a shrunk row strands blank space. An estimate is
 * discarded by that row's very next onLayout, so releasing it buys nothing and costs
 * everything: `ChatListInternal` wires the vendored Legend `getItemSizeVersion` to the
 * full signature key, so an OFFSCREEN row whose shape moves has its measured size
 * deleted and is re-sized from this estimate. Returning `undefined` there sent already
 * scrolled-past rows to the flat content heuristic below, which for a tool row is one compact
 * constant against a painted row measured at 50px in the activity feed and 74..966px in cards
 * (2026-07-29) — collapsing the content above the viewport and pulling the user's scroll
 * position backwards. `resolveLastMeasuredHeight` is therefore read for exactly the case the
 * reservation refuses.
 */
export function estimateTranscriptRowHeightFromCache(params: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    signature: TranscriptItemHeightValiditySignature;
    /**
     * The user utterance this row paints, when the row is the COMMITTED twin of a just-retired
     * pending row (`resolveCommittedUtteranceIdentityForEstimate`). Serves the bubble height the
     * pending block already measured for that same utterance, so the crossover frame is placed from
     * a real measurement instead of the wrap heuristic — see
     * `TranscriptMeasurementReconciler.recordPaintedUtteranceBubbleHeight`.
     */
    committedUtteranceIdentity?: string | null;
}>): number | undefined {
    const reservation = params.reconciler.resolveReservation(params.signature);
    if (reservation?.kind === 'exact') return reservation.minHeight;
    // Consume the reconciler's set rather than re-listing the growing states here: it is the
    // single owner of that decision (`isFloorShapeValid` reads the same set), so a future state
    // cannot silently diverge between the reservation producer and this estimate consumer.
    if (TRANSCRIPT_GROWING_ROW_STATES.has(params.signature.rowState)) return undefined;
    if (reservation) return reservation.minHeight;
    const lastMeasured = params.reconciler.resolveLastMeasuredHeight(params.signature);
    if (lastMeasured !== undefined) return lastMeasured;
    // Ordered strictly after the row's OWN measurement and strictly before the content heuristic:
    // the carried height is a real measurement of the same painted bubble, so it beats a
    // prediction, but it is a measurement of a DIFFERENT row, so it never overrides this row's own.
    return resolveCarriedUtteranceRowHeightPx(params);
}

/**
 * `userMessageWrapper.paddingBottom` — the chrome the committed row adds around a bubble the pending
 * block already painted and measured (`MessageView.tsx`). Everything else in
 * {@link COMMITTED_USER_TEXT_CHROME_PX} is the bubble's own padding, which is inside that
 * measurement.
 *
 * It is the only such chrome ONLY for a plain text send. The committed bubble can also paint a
 * structured card, inline images, unavailable-media items, an attachments row, a structured
 * references row and a discarded label — none of which the pending bubble renders. Those rows are
 * excluded from the carry at the selector rather than modelled here; see
 * {@link resolveCommittedUtteranceIdentityForEstimate}.
 */
const COMMITTED_USER_WRAPPER_PADDING_BOTTOM_PX = 22;

function resolveCarriedUtteranceRowHeightPx(params: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    signature: TranscriptItemHeightValiditySignature;
    committedUtteranceIdentity?: string | null;
}>): number | undefined {
    const identity = params.committedUtteranceIdentity;
    if (typeof identity !== 'string' || identity.length === 0) return undefined;
    const bubbleHeightPx = params.reconciler.resolvePaintedUtteranceBubbleHeight({
        identity,
        widthBucket: params.signature.widthBucket,
        fontScaleKey: params.signature.fontScaleKey,
    });
    if (bubbleHeightPx === undefined) return undefined;
    return bubbleHeightPx + COMMITTED_USER_WRAPPER_PADDING_BOTTOM_PX;
}

/**
 * Does the committed row paint chrome AROUND the bubble that the pending block never rendered?
 *
 * The carry is only valid while the two chains paint the same box. `MessageView`'s user-text branch
 * can add a structured card, inline images, unavailable-media items, an attachments row and a
 * structured references row inside the same bubble — and a structured-only send paints a CARD with
 * no bubble at all. The pending block renders none of them, so its measurement would undershoot by
 * the whole media/reference block (~30-170px each).
 *
 * Every input here is read through the module that OWNS it — the media meta parser, the references
 * resolver, the structured registry — rather than re-derived, so a row that starts painting one of
 * them drops out of the carry automatically instead of being served a stale shape.
 */
function committedRowPaintsChromeBeyondTheBubble(
    message: Extract<Message, { kind: 'user-text' }>,
): boolean {
    const media = parseSessionMediaMessageMeta(message.meta);
    if (media.inlineImages.length > 0 || media.unavailableMedia.length > 0) return true;
    if (media.legacyAttachments !== undefined && media.legacyAttachments !== null) return true;
    const envelope = parseHappierMetaEnvelope(message.meta);
    if (envelope !== null && findStructuredMessageRenderer(envelope.kind) !== null) return true;
    const text = message.displayText ?? message.text ?? '';
    return resolveMessageStructuredReferences({ meta: message.meta, text }).length > 0;
}

/**
 * The utterance identity a COMMITTED row may inherit a painted bubble height from, or `null`.
 *
 * Only a `message` row qualifies: `useTranscriptItemsPipeline` decomposes every `turn` and
 * `tool-calls-group` item into unit rows before `listData`, so a committed user utterance reaches
 * the renderer as its own `message` row, and that row's height IS the bubble plus one wrapper
 * padding. A turn or unit row wraps other content the carried bubble says nothing about — and so
 * does a bubble carrying media, references or a structured card, which is why those fall back to
 * the content heuristic instead of being served a measurement of a different shape.
 */
export function resolveCommittedUtteranceIdentityForEstimate(
    item: TranscriptRowShellItem,
    getMessageById: (messageId: string) => Message | null,
): string | null {
    if (item.kind !== 'message') return null;
    const message = getMessageById(item.messageId);
    if (message?.kind !== 'user-text') return null;
    if (committedRowPaintsChromeBeyondTheBubble(message)) return null;
    return resolveTranscriptUtteranceIdentity(message.localId);
}

// Conservative text-flow constants for rows never measured in this app run. Estimates
// only need to shrink first-visit error (a flat 240px scalar undercounted a real
// transcript by 53% in the live reopen capture 2026-07-23); measurement replaces them
// the moment a row mounts.
const ESTIMATE_COMPACT_ROW_PX = 56;

/**
 * How many characters of transcript body text this model wraps onto one painted line. It is WIDTH
 * BLIND, deliberately, and the accuracy that costs is stated in `estimateWrappedLineCount`.
 *
 * B (2026-08-10) replaced this with a width-aware wrap model whose whole content was one calibrated
 * ratio — an average glyph advance of 0.5em, measured with macOS CoreText over a PROSE corpus. That
 * fix was REVERTED on 2026-08-10 after an independent device verification measured it as the least
 * accurate of the three generations of this model on a real 21,229-character codex reply (326 hard
 * lines, 370px column): real painted row 13,962px; B 16,318px (+16.9%); this model 14,902px (+6.7%).
 * The same session's user bubble painted 518px, which this model returns EXACTLY and B returned as
 * 566px (+9.3%). Inverting those real rows against their own column implies roughly 0.36-0.42em,
 * not 0.5 — a prose corpus is not what an agent transcript paints. The obvious alternative
 * explanation was tested and eliminated: fenced code not wrapping accounts for only +2.9% of the
 * +16.9%.
 *
 * Do NOT reintroduce width-awareness with a better constant. Two messages in one session at one
 * width cannot set a constant, and a second calibrated number is the failure this revert corrects.
 * The condition that would justify a width-aware model is a DEVICE calibration that does not exist
 * yet: painted heights for a spread of real transcript replies (prose, lists, fenced code, tables)
 * across several pane widths and both shipped fonts, from which
 * `(painted - chrome) / lineHeight` gives each row's real line count and `column / lineCount /
 * fontSize` gives the advance directly. Until that exists this stays one flat number, and the root
 * defect it was standing in for is fixed where it lives — see `transcriptRowShellSignature`
 * (R2): a row that is streaming no longer has its real measurement discarded on every chunk, so
 * this estimate is not what positions a row the user is watching.
 */
const ESTIMATE_CHARS_PER_LINE = 72;

/**
 * Painted line count for a text block: hard line breaks plus the flat wrap of the whole string.
 *
 * This over-counts a hard break that falls inside an already-full line and is blind to the row's
 * real column, so it is a coarse predictor — accepted, because after the R2 fix the rows it sizes
 * are the rows nothing has measured yet (first render, jump-to-message, scroll restore), never a
 * row that is actively streaming on screen. Every value it produces is superseded by that row's own
 * onLayout the moment it mounts.
 */
function estimateWrappedLineCount(text: string): number {
    let newlines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) newlines += 1;
    }
    return Math.max(1, newlines + Math.ceil(text.length / ESTIMATE_CHARS_PER_LINE));
}
/**
 * Painted heights of the tool-group row shapes, per RENDERED CHROME VARIANT. Legend places rows
 * by ACCUMULATION, so an estimate that overshoots a row's painted height is not a harmless margin
 * — it is a literal gap under that row, and an undershoot is a literal OVERLAP.
 *
 * P (2026-07-29): these were a single flat set calibrated on the DEFAULT variant
 * (`activity_feed` + group background = `feed_background`), applied unconditionally. But
 * `toolViewTimelineChromeMode` is a user setting (`TranscriptSettingsView`), and in `cards` mode
 * a tool unit row does not paint a single-line timeline row at all — it paints a whole `ToolView`
 * card. A flat 28px against a real card is the undershoot direction, i.e. overlap.
 *
 * MEASURED live in Chrome against the running web build (2026-07-29), rendering the real row
 * components (`ToolCallsGroupUnit{Header,Expand,Tool,Footer}RowWithSessionCommon`) at the default
 * 850px content width. The `feed_background` column reproduces the previously captured 33/28/34
 * exactly, which is what cross-validates the harness against the live 2026-07-28 capture.
 *
 * | variant           | header | expand | tool | footer |
 * |-------------------|--------|--------|------|--------|
 * | `feed`            |   27   |   28   |  28  |   28   |
 * | `feed_background` |   33   |   28   |  28  |   34   |
 *
 * `cards` is deliberately NOT a key here: a tool GROUP cannot exist in that mode. Grouping is
 * gated on the same setting the variant is resolved from — `useChatListRootState` computes
 * `groupToolCalls = transcriptGroupToolCalls === true && toolViewTimelineChromeMode ===
 * 'activity_feed'`, while `resolveToolCallsGroupChromeVariant` returns `cards` exactly when that
 * mode is NOT `activity_feed`. With grouping off, `buildChatListItems` emits no
 * `tool-calls-group` item and `buildTranscriptTurns` emits no `tool_calls` turn content, so
 * `appendToolGroupUnits` (the only producer of `tool-group-*` rows) never runs. A `cards` column
 * would therefore be four numbers no session can reach; the group shapes return `undefined`
 * instead and fall through to the renderer's own estimate, so re-enabling grouping in `cards`
 * mode has to arrive with its own measurement rather than silently inheriting one.
 *
 * Group EXPANSION was measured across all three variants and 7 tool shapes and never changed a
 * unit row's painted height — expansion changes the row COUNT (`appendToolGroupUnits`), not any
 * row's height — so it is deliberately not an input here.
 */
const ESTIMATE_TOOL_ROW_PX = 28;
/**
 * One whole tool card, the shape a tool-call MESSAGE row paints in `cards` mode — the only tool
 * surface that mode has, since grouping is off there (see above). Its height is dominated by the
 * tool's own rendered body, which only that tool's renderer knows, so this is a central estimate
 * for a WIDE distribution rather than a precise height.
 *
 * MEASURED 2026-07-29 on the reachable path: `MessageViewWithSessionCommon` rendered standalone
 * (`layoutContext: 'transcript'`) at the default 850px content width, 19 tool-call fixtures
 * (Read/Bash/Edit/Write/Grep/Glob/TodoWrite/Task/WebFetch/MultiEdit, short and long results):
 * 74, 74, 132, 142, 150, 174, 186, 196, 196, 240, 247, 274, 292, 382, 548, 562, 562, 834, 966 —
 * min 74, median 240, mean 328, max 966. The same fixtures paint a flat 50px in either feed
 * variant, which is what cross-validates the harness.
 *
 * The MEAN is the constant because Legend ACCUMULATES (`positions[i + 1] = positions[i] + size_i`):
 * only a mean keeps the summed content model unbiased over the distribution, which is what decides
 * where an unmeasured row above the viewport places everything below it. (The previous 240 was the
 * mean of the GROUPED unit-row distribution — a shape this branch never renders.) It is superseded
 * by the row's own onLayout the moment it mounts; taller cards still undershoot until measured.
 */
const ESTIMATE_TOOL_CARD_ROW_PX = 328;

/**
 * The `pending-queue` row — the row a SEND creates — sized from the chrome it actually paints.
 *
 * J/D2 (2026-07-30). The previous model summed `estimateTextBlockPx` over every queued and
 * discarded message and floored at the compact constant. That is the height of the SCROLL CONTENT,
 * not of the row, and it was wrong in both directions at once:
 *
 *   - it undershot a single short send. NATIVE MEASUREMENT (iOS simulator, rAF sampler on the
 *     mounted LegendList fiber, `.project/reviews/2026-07-30-send-jiggle-and-anchor/J-send-jiggle.md`):
 *     one short queued message paints **68.625px**, and the old model returned the 56px floor —
 *     a 12.6px UNDERSHOOT, i.e. a literal overlap, re-applied on every pending-record tick because
 *     the row's measured size was being deleted each time (see `transcriptRowShellSignature`).
 *   - it overshot everything else without bound. `PendingMessagesTranscriptBlock` renders its
 *     messages inside a `ScrollView` whose box is `maxHeight: transcriptPendingQueueMaxHeightPx`
 *     (account default **80**), so three 300-char messages paint ~94px while the old model returned
 *     ~438 — a ~340px phantom gap under the tail row during exactly the send the user is watching.
 *
 * DERIVATION, cross-validated against that one measurement. The block paints
 * `TranscriptSeparatorRow` (`padding="none"`, `chipChrome="minimal"`) + optionally the
 * terminal-draft notice + the capped `ScrollView` (`contentContainerStyle.paddingTop: 6`). Each
 * message row is `userMessageWrapper` (`paddingBottom: 8`) wrapping `userMessageBubble`
 * (`paddingVertical: 8` ×2) around markdown at `transcriptMarkdownTextStyle.lineHeight`:
 *
 *   measured baseline: header 14.625 + [ paddingTop 6 + wrapper 8 + bubble 16 + one 24px line ] = 68.625
 *   current row: measured baseline 68.625 + always-visible action row (18px + marginTop 2) = 88.625
 *
 * so `PENDING_QUEUE_HEADER_ROW_PX` is the measured total minus the source-derived content
 * (68.625 − 54). Everything else here is read off those same styles and is therefore DERIVED, not
 * measured: the two-line header (only when queued and discarded rows coexist), the per-message
 * notices, and the discarded section. They sit INSIDE the capped scroll box, so for any queue big
 * enough to reach the cap they cannot move the answer at all.
 *
 * 2026-08-18: the per-message chrome is now composed from the block's own owner
 * (`pendingQueueContentClipping`) rather than restated here — the bubble padding, the inter-row gap
 * (zero under the LAST row) and the scroll cap all come from the same decisions the block paints
 * from. The per-message line clamp still needs no modelling: it is only ever active for a BACKLOG
 * row, and any queue with a backlog already exceeds the cap that truncates this sum.
 */
const PENDING_QUEUE_HEADER_ROW_PX = 14.625;
/** Header grows a second 12px line when the "Discarded (n)" subtitle is present (`gap: 2`). */
const PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX = 31;

/**
 * The in-flow action row under a pending bubble: `messageActionContainer.marginTop` 2 +
 * `IconAction` `padding: 2` ×2 + `Icon size={14}` = 20.
 *
 * CONDITIONAL, and that is the correction (2026-08-18). This term used to be folded unconditionally
 * into the per-message chrome as "always-visible action row 18 + its top margin 2",
 * but `PendingMessagesTranscriptBlock` paints it as `isWeb ? <actions/> : canReorder ? <handle/> :
 * null` — so a lone pending message on native paints NOTHING there. The estimate was 20px over the
 * painted row for every native send (a gap under the tail) and, mirrored, 20px under a web row that
 * is showing a wait notice. Device confirmation: back-solving a 569-char send's steady pending
 * height gives `44.625 + 24L`, i.e. the model WITHOUT this term
 * (`.project/reviews/2026-08-18-send-crossover-native/DEVICE-MEASUREMENT.md`).
 *
 * `paintsPendingMessageActionRow` is the block's own predicate, consumed here rather than restated,
 * so the paint and the estimate cannot diverge again.
 */
const PENDING_QUEUE_MESSAGE_ACTION_ROW_PX = 20;
/** `blockedDeliveryNotice`: margins 4+2, paddingVertical 3 ×2, border 1 ×2, 14px text line = 28. */
const PENDING_QUEUE_MESSAGE_NOTICE_PX = 28;
/** Same notice with the inline retry `Pressable` (`minHeight: 24`) instead of a text line = 38. */
const PENDING_QUEUE_MESSAGE_RETRY_NOTICE_PX = 38;
/** `nonSteerableNotice` — the one notice rendered OUTSIDE (above) the capped scroll box. */
const PENDING_QUEUE_TERMINAL_DRAFT_NOTICE_PX = 40;
/** Discarded section: container margin 4, title 6+14.3, subtitle 4+14.3, list margin 10. */
const PENDING_QUEUE_DISCARDED_SECTION_PX = 53;
/** "Discarded" label (marginTop 6 + 14.3px line) under a discarded bubble. */
const PENDING_QUEUE_DISCARDED_LABEL_PX = 20;
/** `discardedReason` line (marginTop 3 + 14.3px line). */
const PENDING_QUEUE_DISCARDED_REASON_PX = 17;
const PENDING_QUEUE_SCROLL_MAX_HEIGHT_PX = settingsDefaults.transcriptPendingQueueMaxHeightPx;

/** `transcriptPendingMessageCollapsedLines` account default — the clamp a tombstone always paints. */
const PENDING_QUEUE_COLLAPSED_LINES = settingsDefaults.transcriptPendingMessageCollapsedLines;

function estimatePendingQueueTextPx(
    message: Pick<PendingMessage, 'text' | 'displayText'>,
    maxLines?: number,
): number {
    // `displayText ?? text` is the string the block renders (`PendingMessagesTranscriptBlock`); a
    // message with a distinct display form is otherwise sized from text it never paints.
    const rendered = (message.displayText ?? message.text) ?? '';
    const lines = estimateWrappedLineCount(rendered);
    return (maxLines === undefined ? lines : Math.min(lines, maxLines)) * transcriptMarkdownTextStyle.lineHeight;
}

function estimatePendingQueueRowPx(
    item: Extract<TranscriptRowShellItem, { kind: 'pending-queue' }>,
    platformIsWeb: boolean,
): number {
    let scrollContentPx = PENDING_QUEUE_SCROLL_PADDING_TOP_PX;
    let hasTerminalDraftNotice = false;
    // The block's own predicate for the reorder handle, consumed rather than restated.
    const actionRowPx = paintsPendingMessageActionRow({
        platformIsWeb,
        canReorderPendingMessages: item.pendingMessages.length > 1
            && !item.pendingMessages.some(isPendingMessageProviderEffectPossible),
    })
        ? PENDING_QUEUE_MESSAGE_ACTION_ROW_PX
        : 0;
    for (const [index, pendingMessage] of item.pendingMessages.entries()) {
        scrollContentPx += PENDING_QUEUE_MESSAGE_BUBBLE_PADDING_PX
            + resolvePendingMessageGapPx({
                isLastInScrollContent: index === item.pendingMessages.length - 1 && item.discardedMessages.length === 0,
            })
            + actionRowPx
            + estimatePendingQueueTextPx(pendingMessage);
        // The canonical owner of what chrome a pending row paints. Its session-runtime inputs are
        // not reachable from a pure size estimate, so a `queued_behind_turn` wait notice is NOT
        // modelled — it is absorbed by the cap for any queue that reaches it, and superseded by the
        // row's own onLayout otherwise.
        // RESIDUAL, stated rather than engineered around: a head under its own bound has no cap to
        // absorb that notice, so a message queued behind an active turn estimates 20px short
        // (`queuedReasonNotice`: marginTop 4 + 14px line + marginBottom 2) until its own onLayout
        // lands, and only while it paints fewer lines than the bound. It is one frame in one
        // runtime-derived state, and `transcriptRowShellSignature` deliberately does not key on that
        // state, so the row's measured height is never deleted because of it. Threading session
        // runtime into a pure size estimate to model a notice onLayout corrects in the same commit
        // buys a mechanism, not a fix.
        const visualState = getPendingMessageVisualState(pendingMessage);
        // F-P2: switched over the owner's height-bearing descriptor — the very thing
        // `transcriptRowShellSignature` keys the row's size version on — so the estimate and the key
        // can never disagree about which in-flow notice exists.
        switch (resolvePendingMessageHeightBearingChrome(visualState)) {
            case 'retry-notice':
                scrollContentPx += PENDING_QUEUE_MESSAGE_RETRY_NOTICE_PX;
                break;
            case 'blocked-notice':
                scrollContentPx += PENDING_QUEUE_MESSAGE_NOTICE_PX;
                if (visualState.deliveryBlockedReason === 'terminal_composer_draft') hasTerminalDraftNotice = true;
                break;
            case 'wait-notice':
                // Unreachable from here: this call passes no `sessionRuntime`, which is the RESIDUAL
                // stated above rather than engineered around.
                break;
            case 'none':
                break;
        }
    }
    if (item.discardedMessages.length > 0) {
        scrollContentPx += PENDING_QUEUE_DISCARDED_SECTION_PX;
        for (const [discardedIndex, discardedMessage] of item.discardedMessages.entries()) {
            scrollContentPx += PENDING_QUEUE_MESSAGE_BUBBLE_PADDING_PX
                + resolvePendingMessageGapPx({
                    isLastInScrollContent: discardedIndex === item.discardedMessages.length - 1,
                })
                // A tombstone is ALWAYS clamped — the block renders it through a plain `Text` with
                // `numberOfLines={collapsedLines}` and no expand path — so its text term is bounded
                // where a pending row's is not.
                + estimatePendingQueueTextPx(discardedMessage, PENDING_QUEUE_COLLAPSED_LINES)
                + (platformIsWeb ? PENDING_QUEUE_MESSAGE_ACTION_ROW_PX : 0)
                + PENDING_QUEUE_DISCARDED_LABEL_PX
                + (discardedMessage.discardedReason ? PENDING_QUEUE_DISCARDED_REASON_PX : 0);
        }
    }
    const headerPx = item.pendingMessages.length > 0 && item.discardedMessages.length > 0
        ? PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX
        : PENDING_QUEUE_HEADER_ROW_PX;
    // NOT a ceiling on a position-bearing value (see C-1 above): this is the block's OWN painted
    // bound (`resolvePendingQueueScrollMaxHeightPx` is the single owner of it — a disagreement with
    // the renderer is a literal gap or overlap under the tail). The `ScrollView` carries
    // `maxHeight`, so content past it is scrolled, never painted. The account default is modelled
    // because a pure estimate cannot read the setting; a user who raises
    // `transcriptPendingQueueMaxHeightPx` (or expands the queue, which is a post-measurement
    // interaction) undershoots until that row's next onLayout, instead of overshooting without end.
    const scrollBoxPx = Math.min(scrollContentPx, resolvePendingQueueScrollMaxHeightPx({
        pendingCount: item.pendingMessages.length,
        discardedCount: item.discardedMessages.length,
        queueMaxHeightPx: PENDING_QUEUE_SCROLL_MAX_HEIGHT_PX,
        lineHeightPx: transcriptMarkdownTextStyle.lineHeight,
    }));
    return headerPx + (hasTerminalDraftNotice ? PENDING_QUEUE_TERMINAL_DRAFT_NOTICE_PX : 0) + scrollBoxPx;
}

type ToolGroupUnitRowHeights = Readonly<{
    header: number;
    expand: number;
    tool: number;
    footer: number;
}>;

type ToolCallsGroupFeedChromeVariant = Exclude<ToolCallsGroupChromeVariant, 'cards'>;

const TOOL_GROUP_UNIT_ROW_PX_BY_CHROME_VARIANT: Readonly<Record<ToolCallsGroupFeedChromeVariant, ToolGroupUnitRowHeights>> = {
    feed: { header: 27, expand: 28, tool: ESTIMATE_TOOL_ROW_PX, footer: 28 },
    feed_background: { header: 33, expand: 28, tool: ESTIMATE_TOOL_ROW_PX, footer: 34 },
};

/** `undefined` for `cards`: that mode builds no tool-group rows at all (see the table above). */
function resolveToolGroupUnitRowHeights(
    chromeVariant: ToolCallsGroupChromeVariant,
): ToolGroupUnitRowHeights | undefined {
    if (chromeVariant === 'cards') return undefined;
    return TOOL_GROUP_UNIT_ROW_PX_BY_CHROME_VARIANT[chromeVariant];
}

/**
 * Chrome a committed text row paints AROUND its markdown, per message kind — read off the styles
 * that produce it so a style change that invalidates them is findable from here.
 *
 * F1 (2026-08-10). One shared `32 + 22 x lines` model served both shapes, and it was wrong in
 * OPPOSITE directions at once: 8px under for the user row (an accumulation OVERLAP, see C-1 below)
 * and 8px over for the agent row (a GAP). Legend answers a size CHANGE with an MVCP scroll adjust,
 * so on every send the handover from the `pending-queue` row to the new committed row moved the
 * whole list by 14.2px and then a compensating 8px landed AFTER the bubble already looked settled
 * (MEASURED on device, trace batch 2026-08-09,
 * `.project/reviews/2026-08-09-residual-wobble/ATTRIBUTE.md` §M2/M3: 12/12 and 10/10 trials).
 *
 * Each base is the row's non-text chrome, and the line term is the typography the row really
 * paints — the same `transcriptMarkdownTextStyle.lineHeight` the pending block is sized from
 * above, rather than a second constant that can drift from it:
 *
 *   user  22 + 16 + 24 = 62.0  == MEASURED 62.0 (12/12 W1, 10/10 W2)
 *   agent      22 + 24 = 46.0  == MEASURED 46   (10/10)
 *
 * No markdown block margin appears in either: the transcript paragraph style carries
 * `marginTop: 0` and `EnrichedMarkdownTextAdapter` renders with `allowTrailingMargin={false}`, so a
 * single-paragraph row is exactly chrome + lines. A MULTI-block turn still gains each non-final
 * block's `marginBottom` (8px for a paragraph), which this line model does not carry — the same
 * unmodelled term as before, in the undershoot direction, superseded by the row's own onLayout.
 *
 * These two bases are what the 2026-08-10 device verification confirmed and B's revert preserves:
 * the same capture that measured B's wrap model 16.9% over the real row measured this per-kind
 * chrome EXACTLY on the user bubble (518px predicted, 518px painted). The chrome was never the
 * error; the wrap heuristic below it is, and that one stays flat until it can be device-calibrated.
 */
/** `userMessageWrapper.paddingBottom` 22 + `userMessageBubble.paddingVertical` 8 x 2 (`MessageView.tsx`). */
const COMMITTED_USER_TEXT_CHROME_PX = COMMITTED_USER_WRAPPER_PADDING_BOTTOM_PX + 8 * 2;
/** `agentMessageContainer.paddingBottom` 22 (`MessageView.tsx`) — the reply paints no bubble. */
const COMMITTED_AGENT_TEXT_CHROME_PX = 22;

function estimateTextBlockPx(text: string, chromePx: number): number {
    return chromePx + estimateWrappedLineCount(text) * transcriptMarkdownTextStyle.lineHeight;
}

function estimateMessagePx(message: Message | null, chromeVariant: ToolCallsGroupChromeVariant): number {
    if (!message) return ESTIMATE_COMPACT_ROW_PX;
    if (message.kind === 'user-text') {
        return estimateTextBlockPx(message.text, COMMITTED_USER_TEXT_CHROME_PX);
    }
    if (message.kind === 'agent-text') {
        return estimateTextBlockPx(message.text, COMMITTED_AGENT_TEXT_CHROME_PX);
    }
    // The whole tool surface of `cards` mode, since grouping is off there. Measured 2026-07-29: a
    // standalone `MessageView` tool row is 50px in either feed variant (the compact constant is
    // 6px over, left alone) but 74..966px in `cards` — the undershoot direction, and the one
    // accumulation turns into overlap.
    if (message.kind === 'tool-call' && chromeVariant === 'cards') {
        return ESTIMATE_TOOL_CARD_ROW_PX;
    }
    return ESTIMATE_COMPACT_ROW_PX;
}

/**
 * Content-aware size estimate for rows with no prior measurement: text-bearing rows
 * scale with their real text length instead of a flat scalar, so a giant markdown
 * turn no longer collapses the renderer's content model to a fraction of its true
 * height (the estimate-vs-measured relayout oscillation on reopen/switch-back).
 * Non-text and unknown item shapes fall through to the renderer's own estimate.
 *
 * C-1: this value is a POSITION, so it carries no ceiling. Legend accumulates
 * (`positions[i + 1] = positions[i] + size_i`), which is why an overshoot is a literal gap under a
 * row (see `ESTIMATE_TOOL_ROW_PX`) — and, inverted, why an undershoot is a literal OVERLAP. A
 * ceiling guarantees undershoot for every row taller than it, unconditionally. Live web capture
 * 2026-07-28 (`cmrxjkh2v0vintmk4445ywy9s`): a 21,849px markdown message was sized by the former
 * `ESTIMATE_MAX_ROW_PX = 20_000`, so the next row was placed at `A.top + 20000` and painted 1,849px
 * INSIDE it, with that same 1,849px re-surfacing as a phantom tail below the last row. Every box in
 * that capture matched its DOM height exactly: the heights were right and only the ceiling was wrong.
 * A 21,849px message is legitimate content (a very long markdown turn), so the estimate accommodates
 * the real height instead of bounding it — and it is superseded by that row's own onLayout anyway.
 */
export function estimateTranscriptRowHeightFromContent(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    item: TranscriptRowShellItem;
    /**
     * Which chrome the tool rows in this session actually paint, as decided by
     * `resolveToolCallsGroupChromeVariant` — the renderer's own owner. REQUIRED so the compiler,
     * not a default, guarantees the live call site keeps threading it: the previous
     * default-when-omitted parameter on this function ended up exercised only by tests.
     */
    toolCallsGroupChromeVariant: ToolCallsGroupChromeVariant;
    /**
     * Whether this client paints the web pending-message chrome. REQUIRED for the same reason
     * `toolCallsGroupChromeVariant` is: the pending row's in-flow action row is web-only for a lone
     * message (`paintsPendingMessageActionRow`), and a defaulted parameter is how the previous
     * 20px estimate/paint split-brain stayed green.
     */
    platformIsWeb: boolean;
}>): number | undefined {
    const { item, toolCallsGroupChromeVariant } = params;
    const unitRowHeights = resolveToolGroupUnitRowHeights(toolCallsGroupChromeVariant);
    if (item.kind === 'message') {
        return estimateMessagePx(params.getMessageById(item.messageId), toolCallsGroupChromeVariant);
    }
    if (item.kind === 'pending-queue') {
        return estimatePendingQueueRowPx(item, params.platformIsWeb);
    }
    // Per-unit rows, one cap each. They are the ONLY tool-group shape this estimate can be asked
    // about: `useTranscriptItemsPipeline` runs `buildTranscriptTurnUnits` unconditionally over
    // every projection item, and that function consumes every `turn` and `tool-calls-group` item
    // into header/expand/tools/footer units, so neither shape survives into `listData` — the array
    // `getEstimatedItemSize` is called against. Their calibration is what accumulation gaps are
    // made of.
    if (item.kind === 'tool-group-tool') return unitRowHeights?.tool;
    if (item.kind === 'tool-group-expand') return unitRowHeights?.expand;
    if (item.kind === 'tool-group-header') return unitRowHeights?.header;
    if (item.kind === 'tool-group-footer') return unitRowHeights?.footer;
    if (
        item.kind === 'pending-user-action'
        || item.kind === 'action-draft'
        || item.kind === 'fork-divider'
    ) {
        return ESTIMATE_COMPACT_ROW_PX;
    }
    return undefined;
}
