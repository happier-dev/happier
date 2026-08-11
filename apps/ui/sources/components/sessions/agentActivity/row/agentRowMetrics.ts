import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';

/**
 * The row's fixed geometry (4.3).
 *
 * These are the numbers that create the scan axis: a status column whose x-position never moves, and
 * a time column whose width never changes. The pane reads as generic today because both drift — the
 * status is a right-aligned pill that slides with the title, and elapsed time is not rendered at all.
 */

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
 * What to pass as `Item`'s `dividerInset`, so the hairline starts under the title's first glyph.
 *
 * A rule that starts under the status column reads as a table border; one that starts at the title
 * reads as a list, which is what this is.
 *
 * Zero, and deliberately not a per-density table. `Item` already computes
 * `dividerInset + 16 + iconBoxSize + iconMarginRight` (iOS only — the hairline has zero height on
 * Android and web), and it is handed this row's own `AGENT_STATUS_COLUMN_PX` as `iconBoxSize`. So
 * the density terms are already in that sum: adding them here again would double-count them, and
 * subtracting `Item`'s private horizontal padding to correct the remaining 2–6px would duplicate a
 * constant this module does not own for a difference below perception. `Item`'s default of 15
 * would push the rule 15px right of the title, which is the alignment being fixed.
 */
export const AGENT_ROW_DIVIDER_INSET_PX = 0;

/**
 * Where a disclosed body's left edge sits, under the row that opened it.
 *
 * The roster is pinned compact everywhere (`AGENT_ACTIVITY_SURFACE_DENSITY`), so the body starts on
 * the same content edge as the row's own text block rather than at a hardcoded `26` — a number that
 * was copied into two detail components, belonged to the icon geometry of a row that no longer
 * exists, and over-indented a preview inside a 420pt popover where width is the scarce resource.
 */
export const AGENT_ROW_DETAIL_INSET_PX = ITEM_ROW_PADDING_HORIZONTAL.compact;
