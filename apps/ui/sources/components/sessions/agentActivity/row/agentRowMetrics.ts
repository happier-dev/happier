import { StyleSheet } from 'react-native';

import {
    ITEM_ICON_MARGIN_RIGHT,
    ITEM_ROW_PADDING_HORIZONTAL,
} from '@/components/ui/lists/itemDensityMetrics';
import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';

/**
 * The row's fixed geometry (4.3).
 *
 * These are the numbers that create the scan axis: a status column whose x-position never moves, and
 * a time column whose width never changes. The pane reads as generic today because both drift — the
 * status is a right-aligned pill that slides with the title, and elapsed time is not rendered at all.
 */

/**
 * The density every agent row is drawn at, in every host. Pinned, never inherited.
 *
 * The Agents pane used to take the user's `uiItemDensity` (default cozy), so the same agent was one
 * density step LARGER in the monitoring surface than in the popover the reader had just pressed to
 * get there — and the subagent details header, which inherited it too, was larger again than the
 * roster behind it. A list-density preference is about how much of a settings screen or a file tree
 * fits at once; it has no business sizing an agent roster.
 *
 * It lives here rather than beside the surface because the surface is not the only host: the
 * details header renders a bare row and must reach the same answer without importing a component
 * that carries a router and a run panel with it.
 */
export const AGENT_ACTIVITY_SURFACE_DENSITY: ResolvedItemDensity = 'compact';

/** Glyph ink size in the status column. Feeds `iconMatchedSpinnerSize` for the running spinner. */
export const AGENT_STATUS_GLYPH_PX: Record<ResolvedItemDensity, number> = {
    comfortable: 20,
    cozy: 20,
    compact: 16,
    tight: 16,
};

/** The fixed leading column. Larger than the glyph so a spinner and a glyph share one box. */
export const AGENT_STATUS_COLUMN_PX: Record<ResolvedItemDensity, number> = {
    comfortable: 24,
    cozy: 24,
    compact: 20,
    tight: 20,
};

/**
 * Fits `1h 04m` at `Typography.timestamp()` with tabular numerals.
 *
 * A minimum, not a width: the column reserves enough room that `0:42` growing to `10:42` does not
 * shift the row, which is the whole reason the elapsed value is safe to tick once a second.
 */
export const AGENT_TIME_SLOT_MIN_PX = 46;

/**
 * Two stable row heights, chosen by whether an overflow menu actually rendered — never by a prop.
 *
 * A flat 44/52 everywhere would grow the transcript card body from 192 to 312px at six agents and
 * the work-state popover from 768 to 1248px at twenty-four rows: the "flattening workflow richness"
 * regression. A row that carries a destructive action needs the 44pt touch target; a read-only
 * workflow-agent row has nothing to hit, so it keeps workflow's existing density.
 */
export const AGENT_ROW_MIN_HEIGHT_PX = {
    withActions: 44,
    readOnly: 32,
} as const;

/**
 * The horizontal gap between the two icon controls in the row's right cluster, and the touch slop
 * each of them extends its 28pt box by.
 *
 * **One owner, because they are one decision.** The caret and the overflow are separate components
 * and each used to name its own `8`; two neighbouring controls whose hit areas are decided
 * independently is precisely how they came to overlap by 12pt, so that a tap in the seam between
 * them was a coin flip between "glance" and "menu".
 *
 * The slop is derived from the gap rather than typed beside it: each control reaches exactly to the
 * midpoint of the space between them, so the two hit areas meet without overlapping and every point
 * in the cluster belongs to exactly one control. The vertical slop is independent — nothing sits
 * above or below these controls inside the row — and takes the 28pt box to the row's 44pt height.
 */
export const AGENT_ROW_ACTION_GAP_PX = 12;

export const AGENT_ROW_ACTION_HIT_SLOP = {
    // 28 + 8 + 8 = the 44pt row height. Nothing sits above or below these controls, so the vertical
    // reach costs nothing and a finger arriving high or low still lands on the control it aimed at.
    top: 8,
    bottom: 8,
    // Half the gap each, which is what makes the seam a boundary rather than a contested band. It
    // leaves each control 40pt wide instead of 44 — the deliberate trade, because an unambiguous
    // 40pt target beats a 44pt one whose last 12pt are a coin flip with its neighbour.
    left: AGENT_ROW_ACTION_GAP_PX / 2,
    right: AGENT_ROW_ACTION_GAP_PX / 2,
} as const;

/**
 * The rule between two agent rows — drawn by the row itself, on every platform (RULING-15).
 *
 * **Why the row draws it rather than `Item`.** `Item`'s hairline is
 * `Platform.select({ ios: 0.33, default: 0 })`: zero height on Android and on web. That was
 * survivable while this roster had a `gap: 10` holding its rows apart, and it stopped being
 * survivable when the roster went compact and the gap went with it — on two of the three platforms
 * the rows then had no separation at all. Changing `Item` would restyle every list in the app to
 * repair one corridor, so the corridor draws its own, once, in the one component every host of an
 * agent row already renders: the popover, the pane, the run panel and the details header get the
 * same rule with no host able to opt out of it.
 *
 * **One hairline, not two.** `AgentActivityRow` passes `showDivider={false}` to `Item`, so on iOS
 * there is exactly one rule here and it is this one.
 */
export const AGENT_ROW_SEPARATOR_HEIGHT_PX = StyleSheet.hairlineWidth || 1;

/**
 * Where that rule starts: under the title's first glyph, never under the status column.
 *
 * A rule that runs the full width reads as a table border; one that starts at the title reads as a
 * list, which is what this is. Derived from the three constants that actually place the title —
 * the row's own padding, the status column it reserves, and the gap after it — rather than typed,
 * because a typed number is what silently stops matching when a density changes. `Item`'s own iOS
 * formula hardcodes a `16` that is only correct at comfortable density; at compact this lands the
 * rule 4px further left, exactly on the text.
 */
function resolveSeparatorInsetPx(density: ResolvedItemDensity): number {
    return ITEM_ROW_PADDING_HORIZONTAL[density]
        + AGENT_STATUS_COLUMN_PX[density]
        + ITEM_ICON_MARGIN_RIGHT[density];
}

export const AGENT_ROW_SEPARATOR_INSET_PX: Record<ResolvedItemDensity, number> = {
    comfortable: resolveSeparatorInsetPx('comfortable'),
    cozy: resolveSeparatorInsetPx('cozy'),
    compact: resolveSeparatorInsetPx('compact'),
    tight: resolveSeparatorInsetPx('tight'),
};

/**
 * Where a disclosed body's left edge sits, under the row that opened it.
 *
 * The roster is pinned compact everywhere (`AGENT_ACTIVITY_SURFACE_DENSITY`), so the body starts on
 * the same content edge as the row's own text block rather than at a hardcoded `26` — a number that
 * was copied into two detail components, belonged to the icon geometry of a row that no longer
 * exists, and over-indented a preview inside a 420pt popover where width is the scarce resource.
 */
export const AGENT_ROW_DETAIL_INSET_PX = ITEM_ROW_PADDING_HORIZONTAL.compact;
