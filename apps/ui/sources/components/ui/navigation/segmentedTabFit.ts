/**
 * How a row of tabs fits its measured width (D44): every tab with its glyph; then the labels alone
 * (a narrow window drops the glyphs first, lab `p-overview` FIT); then the names without their quiet
 * counts (a count is never worth a cut name: "Needs you…"); then as many names as fit, in order,
 * with the rest behind More. A dropped count stays in each tab's accessible name. Nothing here
 * counts tabs or assumes a width: the inputs are the row's own measured box and each tab's own
 * measured width, so long translations, large text and a split pane all resolve the same way.
 * The selected tab never goes behind More: when it falls past the names that fit, the leading tabs
 * give way until it fits after them, and the row draws it there (`keep`).
 */
export type SegmentedTabFit = Readonly<{
  /** Whether the visible tabs draw their glyphs. */
  icons: boolean;
  /** Whether the visible tabs draw their counts. */
  counts: boolean;
  /**
   * How many leading tabs stay in the row; the rest open from More. A kept tab past them is drawn
   * after them, and this count already leaves its room.
   */
  visibleCount: number;
}>;

export type SegmentedTabFitInput = Readonly<{
  /** The row's measured width; null before the first layout. */
  available: number | null;
  /** Each tab's measured width with its glyph, in order. */
  withIcons: readonly number[];
  /** Each tab's measured width as a label alone, in order. */
  labelsOnly: readonly number[];
  /** Each tab's measured width as its name alone, without its count; defaults to `labelsOnly`. */
  labelsWithoutCounts?: readonly number[];
  /** The space between two tabs. */
  gap: number;
  /** The More trigger's measured width. */
  more: number;
  /** Explicit overflow keeps More present even when every pinned tab fits. */
  reserveMore?: boolean;
  /** The selected tab's index: it stays in the row whatever the width. */
  keep?: number | null;
}>;

function rowWidth(
  widths: readonly number[],
  count: number,
  gap: number,
): number {
  let total = 0;
  for (let index = 0; index < count; index += 1) total += widths[index] ?? 0;
  return total + Math.max(0, count - 1) * gap;
}

export function resolveSegmentedTabFit(
  input: SegmentedTabFitInput,
): SegmentedTabFit {
  const count = input.labelsOnly.length;
  // Before the row is measured every tab stays in place, so nothing jumps into More on arrival.
  if (input.available === null || count === 0)
    return { icons: true, counts: true, visibleCount: count };
  const tolerance = 0.5;
  const reserved = input.reserveMore ? input.gap + input.more : 0;
  if (
    rowWidth(input.withIcons, count, input.gap) + reserved <=
    input.available + tolerance
  )
    return { icons: true, counts: true, visibleCount: count };
  if (
    rowWidth(input.labelsOnly, count, input.gap) + reserved <=
    input.available + tolerance
  )
    return { icons: false, counts: true, visibleCount: count };
  const names = input.labelsWithoutCounts ?? input.labelsOnly;
  if (rowWidth(names, count, input.gap) + reserved <= input.available + tolerance)
    return { icons: false, counts: false, visibleCount: count };
  let visible = count - 1;
  while (
    visible > 0 &&
    rowWidth(names, visible, input.gap) + input.gap + input.more >
      input.available + tolerance
  ) {
    visible -= 1;
  }
  const keep = input.keep ?? null;
  if (keep === null || keep < visible || keep >= count)
    return { icons: false, counts: false, visibleCount: visible };
  // The selected tab sits past the names that fit: the leading tabs give way until it fits after them.
  const keptRoom = (names[keep] ?? 0) + input.gap;
  while (
    visible > 0 &&
    rowWidth(names, visible, input.gap) + input.gap + input.more + keptRoom >
      input.available + tolerance
  ) {
    visible -= 1;
  }
  return { icons: false, counts: false, visibleCount: visible };
}
