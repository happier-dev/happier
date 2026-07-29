import type { Message } from '@/sync/domains/messages/messageTypes';
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
 * text better. Every other row state is shrink-capable, and for those the reconciler
 * only ever serves a floor recorded from the row's CURRENT structural shape — i.e. the
 * row's own last measurement at this width/font. That is a real measurement, not a
 * prediction; it is served through the floor because the exact-height cache is
 * stable-only and a row that never reaches `stable` (every `pending-action` row:
 * `pending-queue`, `pending-user-action`, `action-draft`) structurally cannot enter it.
 */
export function estimateTranscriptRowHeightFromCache(params: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    signature: TranscriptItemHeightValiditySignature;
}>): number | undefined {
    const reservation = params.reconciler.resolveReservation(params.signature);
    if (!reservation) return undefined;
    if (reservation.kind === 'exact') return reservation.minHeight;
    // Consume the reconciler's set rather than re-listing the growing states here: it is the
    // single owner of that decision (`isFloorShapeValid` reads the same set), so a future state
    // cannot silently diverge between the reservation producer and this estimate consumer.
    if (TRANSCRIPT_GROWING_ROW_STATES.has(params.signature.rowState)) return undefined;
    return reservation.minHeight;
}

// Conservative text-flow constants for rows never measured in this app run. Estimates
// only need to shrink first-visit error (a flat 240px scalar undercounted a real
// transcript by 53% in the live reopen capture 2026-07-23); measurement replaces them
// the moment a row mounts.
const ESTIMATE_ROW_BASE_PX = 32;
const ESTIMATE_LINE_HEIGHT_PX = 22;
const ESTIMATE_CHARS_PER_LINE = 72;
const ESTIMATE_COMPACT_ROW_PX = 56;

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

function estimateTextBlockPx(text: string): number {
    let newlines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) newlines += 1;
    }
    const lines = Math.max(1, newlines + Math.ceil(text.length / ESTIMATE_CHARS_PER_LINE));
    return ESTIMATE_ROW_BASE_PX + lines * ESTIMATE_LINE_HEIGHT_PX;
}

function estimateMessagePx(message: Message | null, chromeVariant: ToolCallsGroupChromeVariant): number {
    if (!message) return ESTIMATE_COMPACT_ROW_PX;
    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        return estimateTextBlockPx(message.text);
    }
    // The whole tool surface of `cards` mode, since grouping is off there. Measured 2026-07-29 in
    // this repo: a standalone `MessageView` tool row is 50px in either feed variant (the compact
    // constant is 6px over, left alone) but 74..966px in `cards` — the undershoot direction, and
    // the one accumulation turns into overlap.
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
        // The row a SEND creates. It renders one text block per queued and per discarded message,
        // reading `displayText ?? text` (`PendingMessagesTranscriptBlock.tsx:41`) — estimate from
        // the SAME string the row renders, or a message with a distinct display form is mis-sized.
        // Iterate both arrays directly: `getEstimatedItemSize` runs per row per render, so the
        // concatenated copy would be a per-row allocation in a hot path.
        let total = 0;
        for (const pendingMessage of item.pendingMessages) {
            total += estimateTextBlockPx(pendingMessage.displayText ?? pendingMessage.text);
        }
        for (const discardedMessage of item.discardedMessages) {
            total += estimateTextBlockPx(discardedMessage.displayText ?? discardedMessage.text);
        }
        return Math.max(ESTIMATE_COMPACT_ROW_PX, total);
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
        || item.kind === 'action-draft'
        || item.kind === 'fork-divider'
    ) {
        return ESTIMATE_COMPACT_ROW_PX;
    }
    return undefined;
}
