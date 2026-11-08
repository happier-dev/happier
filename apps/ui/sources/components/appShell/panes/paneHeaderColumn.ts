import { HAPPIER_ICON_BUTTON_SIZE } from '@happier-dev/plugin-ui/presentation';

import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { HEADER_BAND_HORIZONTAL_PADDING_PX } from '@/components/ui/layout/headerBand';

/**
 * The trailing icon buttons' glyphs (⋯, Close) end on the pane's content edge, the line its rows' values and
 * chevrons end on, mirroring the title on the leading edge: the band's trailing padding is that edge less the
 * glyph's own inset in its button.
 */
export const PANE_HEADER_BAND_TRAILING_PADDING_PX =
  HEADER_BAND_HORIZONTAL_PADDING_PX -
  (HAPPIER_ICON_BUTTON_SIZE -
    resolveIconButtonGlyphSize(HAPPIER_ICON_BUTTON_SIZE)) /
    2;

/**
 * The width of a band's contents when they align with a centred content column beneath it (a Session's
 * transcript and composer). The band keeps its own insets, which equal the column's side gutters, and its
 * contents are centred at this width: the title starts on the column's leading edge and the trailing glyph
 * ends on its trailing edge, so header and content share one column at every pane width. The band's own
 * paint and shade still span the pane.
 */
export function resolvePaneHeaderColumnMaxWidthPx(
  columnMaxWidthPx: number,
): number {
  return (
    columnMaxWidthPx +
    HEADER_BAND_HORIZONTAL_PADDING_PX -
    PANE_HEADER_BAND_TRAILING_PADDING_PX
  );
}
