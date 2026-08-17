import {
    getPendingMessageVisualState,
    resolvePendingMessageHeightBearingChrome,
} from '@/components/sessions/pending/pendingMessageVisualState';
import { shouldClipPendingQueueContent } from '@/components/sessions/pending/pendingQueueContentClipping';
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
 * deleted and is re-sized from this estimate.
 *
 * Returning `undefined` there sent already scrolled-past rows to the flat content
 * heuristic below — and, at the streaming -> stable SETTLE boundary, sent the row the
 * user is watching there too. R2 keeps a growing row's measured size alive across every
 * chunk (its structural key became identity-only), but BOTH `rowState` and
 * `structuralKey` move at the finalize, so `validateItemSizeVersion` deletes that size
 * exactly once per settle while the exact-height cache has no entry for the settled
 * signature yet — and the app's own final streamed measurement was thrown away with it.
 * The flat model that replaced it measured +6.7% against a real 21,229-character reply
 * on device (2026-08-10); Legend places by accumulation, so that is a visible jump.
 * `resolveLastMeasuredHeight` is therefore read for exactly the case the reservation
 * refuses.
 */
export function estimateTranscriptRowHeightFromCache(params: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    signature: TranscriptItemHeightValiditySignature;
}>): number | undefined {
    const reservation = params.reconciler.resolveReservation(params.signature);
    if (reservation?.kind === 'exact') return reservation.minHeight;
    // Consume the reconciler's set rather than re-listing the growing states here: it is the
    // single owner of that decision (`isFloorShapeValid` reads the same set), so a future state
    // cannot silently diverge between the reservation producer and this estimate consumer.
    if (TRANSCRIPT_GROWING_ROW_STATES.has(params.signature.rowState)) return undefined;
    if (reservation) return reservation.minHeight;
    return params.reconciler.resolveLastMeasuredHeight(params.signature);
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
 * | variant           | header | expand | tool | footer |
 * |-------------------|--------|--------|------|--------|
 * | `feed`            |   27   |   28   |  28  |   28   |
 * | `feed_background` |   33   |   28   |  28  |   34   |
 *
 * Evidence basis: measured live in Chrome in the sibling repo (2026-07-29) by rendering the real
 * row components (`ToolCallsGroupUnit{Header,Expand,Tool,Footer}RowWithSessionCommon`) at the
 * default 850px content width, against the production estimator (per-row error 0 for every cap in
 * every variant). They transfer here because the row shells that paint them are the same code —
 * `ToolCallsGroupUnitExpandRow` / `ToolCallsGroupUnitFooterRow` are byte-identical across the two
 * repos, `ToolCallsGroupUnitHeaderRow` / `ToolCallsGroupUnitToolRow` differ only in an import path
 * and a pin-resolution detail, and every geometry-bearing style in `toolCallsGroupChrome`
 * (paddings, gaps, font sizes, gutter widths) is byte-identical. That is derived, not re-measured
 * here; any future divergence in those shells has to re-derive these caps.
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
 * MEASURED IN THIS REPO 2026-07-29 (not derived from the sibling: a card's height is owned by each
 * tool renderer, which is exactly where the two repos diverge — this sample differs from the
 * sibling's on Read and WebFetch). `MessageViewWithSessionCommon` rendered standalone
 * (`layoutContext: 'transcript'`) against this repo's running web build at the default 850px
 * content width, 19 tool-call fixtures (Read/Bash/Edit/Write/Grep/Glob/TodoWrite/Task/WebFetch/
 * MultiEdit, short and long results): 74, 74, 132, 142, 150, 174, 180, 196, 196, 240, 247, 274,
 * 292, 376, 548, 556, 556, 834, 966 — min 74, median 240, mean 327, max 966. The same fixtures
 * paint a flat 50px in either feed variant, which is what cross-validates the harness.
 *
 * The MEAN is the constant because Legend ACCUMULATES (`positions[i + 1] = positions[i] + size_i`):
 * only a mean keeps the summed content model unbiased over the distribution, which is what decides
 * where an unmeasured row above the viewport places everything below it. (The previous 240 was the
 * mean of the sibling repo's GROUPED unit-row distribution — a shape this branch never renders.)
 * It is superseded by the row's own onLayout the moment it mounts; taller cards still undershoot
 * until measured.
 */
const ESTIMATE_TOOL_CARD_ROW_PX = 327;

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
 *   header 14.625 + [ paddingTop 6 + wrapper 8 + bubble 16 + one 24px line ] = 68.625  ✓ measured
 *
 * so `PENDING_QUEUE_HEADER_ROW_PX` is the measured total minus the source-derived content
 * (68.625 − 54). Everything else here is read off those same styles and is therefore DERIVED, not
 * measured: the two-line header (only when queued and discarded rows coexist), the per-message
 * notices, and the discarded section. They sit INSIDE the capped scroll box, so for any queue big
 * enough to reach the cap they cannot move the answer at all.
 */
const PENDING_QUEUE_HEADER_ROW_PX = 14.625;
/** Header grows a second 12px line when the "Discarded (n)" subtitle is present (`gap: 2`). */
const PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX = 31;
const PENDING_QUEUE_SCROLL_PADDING_TOP_PX = 6;
/** Bubble padding 16 + wrapper bottom 8 + the always-visible 18px action row and its 2px top margin. */
const PENDING_QUEUE_MESSAGE_CHROME_PX = 44;
/** `blockedDeliveryNotice` (this repo): marginTop 8, paddingVertical 5 ×2, hairline border, 14px text line. */
const PENDING_QUEUE_MESSAGE_NOTICE_PX = 33;
// `nonSteerableNotice` (the one notice rendered OUTSIDE the capped scroll box) is deliberately NOT
// modelled in this repo: `showNonSteerableNotice` is decided by live session capabilities
// (`inFlightSteerUnavailableReason`, `terminalComposerDraftPresent`, runtime activity), none of
// which a pure size estimate over the projection item can see. Its ~40px is left to the row's own
// onLayout. (The sibling repo derives the same notice from the pending RECORD and does model it.)
/** Discarded section: container margin 4, title 6+14.3, subtitle 4+14.3, list margin 10. */
const PENDING_QUEUE_DISCARDED_SECTION_PX = 53;
/** "Discarded" label (marginTop 6 + 14.3px line) under a discarded bubble. */
const PENDING_QUEUE_DISCARDED_LABEL_PX = 20;
/** `discardedReason` line (marginTop 3 + 14.3px line). */
const PENDING_QUEUE_DISCARDED_REASON_PX = 17;
const PENDING_QUEUE_SCROLL_MAX_HEIGHT_PX = settingsDefaults.transcriptPendingQueueMaxHeightPx;

function estimatePendingQueueTextPx(message: Pick<PendingMessage, 'text' | 'displayText'>): number {
    // `displayText ?? text` is the string the block renders (`PendingMessagesTranscriptBlock`); a
    // message with a distinct display form is otherwise sized from text it never paints.
    const rendered = (message.displayText ?? message.text) ?? '';
    return estimateWrappedLineCount(rendered) * transcriptMarkdownTextStyle.lineHeight;
}

function estimatePendingQueueRowPx(item: Extract<TranscriptRowShellItem, { kind: 'pending-queue' }>): number {
    let scrollContentPx = PENDING_QUEUE_SCROLL_PADDING_TOP_PX;
    for (const pendingMessage of item.pendingMessages) {
        scrollContentPx += PENDING_QUEUE_MESSAGE_CHROME_PX + estimatePendingQueueTextPx(pendingMessage);
        // F-P2: switched over the owner's height-bearing descriptor — the very thing
        // `transcriptRowShellSignature` keys the row's size version on — so the estimate and the key
        // can never disagree about which in-flow notice exists. This removed a 43px phantom the
        // estimate added for every `send_failed` row: the block paints no send-failed notice, only a
        // retry affordance inside its constant-height web action row.
        const visualState = getPendingMessageVisualState(pendingMessage);
        switch (resolvePendingMessageHeightBearingChrome(visualState)) {
            case 'blocked-notice':
                scrollContentPx += PENDING_QUEUE_MESSAGE_NOTICE_PX;
                break;
            case 'none':
                break;
        }
    }
    if (item.discardedMessages.length > 0) {
        scrollContentPx += PENDING_QUEUE_DISCARDED_SECTION_PX;
        for (const discardedMessage of item.discardedMessages) {
            scrollContentPx += PENDING_QUEUE_MESSAGE_CHROME_PX
                + estimatePendingQueueTextPx(discardedMessage)
                + PENDING_QUEUE_DISCARDED_LABEL_PX
                + (discardedMessage.discardedReason ? PENDING_QUEUE_DISCARDED_REASON_PX : 0);
        }
    }
    const headerPx = item.pendingMessages.length > 0 && item.discardedMessages.length > 0
        ? PENDING_QUEUE_HEADER_WITH_SUBTITLE_PX
        : PENDING_QUEUE_HEADER_ROW_PX;
    // NOT a ceiling on a position-bearing value (see C-1 above): this is the block's OWN painted
    // bound. The `ScrollView` carries `maxHeight`, so content past it is scrolled, never painted.
    // The account default is modelled because a pure estimate cannot read the setting; a user who
    // raises `transcriptPendingQueueMaxHeightPx` (or expands the queue, which is a post-measurement
    // interaction) undershoots until that row's next onLayout, instead of overshooting without end.
    const scrollBoxPx = shouldClipPendingQueueContent({
        pendingCount: item.pendingMessages.length,
        discardedCount: item.discardedMessages.length,
    })
        ? Math.min(scrollContentPx, PENDING_QUEUE_SCROLL_MAX_HEIGHT_PX)
        : scrollContentPx;
    return headerPx + scrollBoxPx;
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
 * whole list by 14.2px and then a compensating 8px landed AFTER the bubble already looked settled.
 *
 * Each base is the row's non-text chrome, and the line term is the typography the row really
 * paints — the same `transcriptMarkdownTextStyle.lineHeight` the pending block is sized from
 * above, rather than a second constant that can drift from it:
 *
 *   user  22 + 16 + 24 = 62.0
 *   agent      22 + 24 = 46.0
 *
 * Evidence basis: those two totals were MEASURED on device in the sibling repo (iOS simulator, rAF
 * sampler on the mounted LegendList fiber, trace batch 2026-08-09 — 62.0 in 12/12 and 10/10
 * trials, 46 in 10/10). They are DERIVED here from this repo's own bytes, and they transfer
 * because every term is byte-identical in this repo's `MessageView`: `userMessageWrapper`
 * `paddingBottom: 22`, `userMessageBubble` `paddingVertical: 8`, `agentMessageContainer`
 * `paddingBottom: 22`, `userMessageContainer` with no vertical padding, and
 * `transcriptMarkdownTextStyle.lineHeight` 24. A future divergence in those styles has to
 * re-derive these bases.
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
const COMMITTED_USER_TEXT_CHROME_PX = 22 + 8 * 2;
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
 * (`positions[i + 1] = positions[i] + size_i`), which is why an overshoot is a literal gap under
 * a row (see `ESTIMATE_TOOL_ROW_PX`) — and, inverted, why an undershoot is a literal OVERLAP. A
 * ceiling guarantees undershoot for every row taller than it, unconditionally. A 21,849px
 * markdown message sized by the former `ESTIMATE_MAX_ROW_PX = 20_000` placed the next row at
 * `A.top + 20000`, painting it 1,849px INSIDE row A, with that same 1,849px re-surfacing as a
 * phantom tail below the last row. A giant markdown turn is legitimate content, so the estimate
 * accommodates the real height instead of bounding it — and it is superseded by that row's own
 * onLayout anyway.
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
}>): number | undefined {
    const { item, toolCallsGroupChromeVariant } = params;
    const unitRowHeights = resolveToolGroupUnitRowHeights(toolCallsGroupChromeVariant);
    if (item.kind === 'message') {
        return estimateMessagePx(params.getMessageById(item.messageId), toolCallsGroupChromeVariant);
    }
    if (item.kind === 'pending-queue') {
        return estimatePendingQueueRowPx(item);
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
        || item.kind === 'external-session-operation'
        || item.kind === 'plugin-transcript-activity'
        || item.kind === 'action-draft'
        || item.kind === 'fork-divider'
    ) {
        return ESTIMATE_COMPACT_ROW_PX;
    }
    return undefined;
}
