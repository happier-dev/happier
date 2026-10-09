/**
 * How a row of tabs fits its measured width (D44): every tab with its glyph; then the labels alone
 * (a narrow window drops the glyphs first, lab `p-overview` FIT); then as many labels as fit, in
 * order, with the rest behind More. Nothing here counts tabs or assumes a width: the inputs are the
 * row's own measured box and each tab's own measured width, so long translations, large text and a
 * split pane all resolve the same way.
 */
export type SegmentedTabFit = Readonly<{
  /** Whether the visible tabs draw their glyphs. */
  icons: boolean;
  /** How many leading tabs stay in the row; the rest open from More. */
  visibleCount: number;
}>;

export type SegmentedTabFitInput = Readonly<{
  /** The row's measured width; null before the first layout. */
  available: number | null;
  /** Each tab's measured width with its glyph, in order. */
  withIcons: readonly number[];
  /** Each tab's measured width as a label alone, in order. */
  labelsOnly: readonly number[];
  /** The space between two tabs. */
  gap: number;
  /** The More trigger's measured width. */
  more: number;
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
    return { icons: true, visibleCount: count };
  const tolerance = 0.5;
  if (
    rowWidth(input.withIcons, count, input.gap) <=
    input.available + tolerance
  )
    return { icons: true, visibleCount: count };
  if (
    rowWidth(input.labelsOnly, count, input.gap) <=
    input.available + tolerance
  )
    return { icons: false, visibleCount: count };
  let visible = count - 1;
  while (
    visible > 0 &&
    rowWidth(input.labelsOnly, visible, input.gap) + input.gap + input.more >
      input.available + tolerance
  ) {
    visible -= 1;
  }
  return { icons: false, visibleCount: visible };
}
