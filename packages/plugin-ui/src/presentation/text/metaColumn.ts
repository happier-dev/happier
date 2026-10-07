/**
 * The meta column of a row (DESIGN.md → "Meta lines up"): a row's time, count or size sits
 * right-aligned in tabular figures, at least this wide, so a list's meta scans as one vertical column
 * and a changing count never jitters. Every row primitive (plugin-ui `HappierListItem`, Happier core's
 * `Item` and session rows) draws its trailing meta with this one style.
 */
export const HAPPIER_META_COLUMN_V1 = Object.freeze({
  /** Wide enough for the common short forms ("12m", "11h", "07:00"), so their left edges line up too. */
  minWidthPx: 30,
});

/** The trailing meta text of a row: tabular figures, right-aligned, at the column's minimum width. */
export const HAPPIER_META_COLUMN_STYLE: Readonly<{
  fontVariant: Array<'tabular-nums'>;
  textAlign: 'right';
  minWidth: number;
}> = Object.freeze({
  fontVariant: ['tabular-nums' as const],
  textAlign: 'right' as const,
  minWidth: HAPPIER_META_COLUMN_V1.minWidthPx,
});
