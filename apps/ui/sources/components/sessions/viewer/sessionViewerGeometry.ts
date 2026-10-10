import type { FrameRect } from '@happier-dev/plugin-ui/presentation';

/** The viewer's gutter from the transcript area's edges (the floating presences' 16). */
export const SESSION_VIEWER_EDGE = 16;
/**
 * The first floating width, as a share of the measured area: a presentation default the person
 * resizes, not a ceiling. The lab's 420 of a ~1000 reading area.
 */
export const DEFAULT_WIDTH_SHARE = 0.42;
/** The live picture's aspect until the source reports its own. */
export const SESSION_VIEWER_DEFAULT_ASPECT = 16 / 10;

/**
 * How far the centred reading column must yield so a settled floating viewer does not cover it.
 * The column keeps its width while the free margin allows, then narrows; zero when it already fits.
 * It never narrows below `columnMinWidth`, the main content's minimum width (the same threshold at
 * which a widened Details pane stops squeezing the main content and overlays it): past that the
 * column stays where it is and the viewer floats over it.
 */
export function resolveSessionViewerReadingInset(
  input: Readonly<{
    areaWidth: number;
    columnMaxWidth: number;
    columnMinWidth: number;
    rect: FrameRect;
  }>,
): Readonly<{ left: number; right: number }> {
  const { areaWidth, columnMaxWidth, rect } = input;
  const leftSide = rect.x + rect.width / 2 < areaWidth / 2;
  // The free edge the reading column may reach, measured from its side of the area.
  const reach = leftSide
    ? areaWidth - (rect.x + rect.width + SESSION_VIEWER_EDGE)
    : rect.x - SESSION_VIEWER_EDGE;
  if (reach <= 0) return { left: 0, right: 0 };
  const column = Math.min(areaWidth, columnMaxWidth);
  const columnEdge = (areaWidth + column) / 2;
  if (columnEdge <= reach) return { left: 0, right: 0 };
  // Recentre in the remaining width: keep the column while (W - P + max) / 2 <= reach, else narrow.
  const keep = areaWidth + columnMaxWidth - 2 * reach;
  const inset = areaWidth - keep >= columnMaxWidth ? keep : areaWidth - reach;
  const yielded = Math.max(0, Math.ceil(inset));
  if (areaWidth - yielded < input.columnMinWidth) return { left: 0, right: 0 };
  return leftSide ? { left: yielded, right: 0 } : { left: 0, right: yielded };
}
