import { describe, expect, it } from 'vitest';
import { HAPPIER_ICON_BUTTON_SIZE } from '@happier-dev/plugin-ui/presentation';

import { resolveAgentInputColumn } from '@/components/sessions/agentInput/layout/agentInputColumn';
import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { HEADER_BAND_HORIZONTAL_PADDING_PX } from '@/components/ui/layout/headerBand';

import {
  PANE_HEADER_BAND_TRAILING_PADDING_PX,
  resolvePaneHeaderColumnMaxWidthPx,
} from './paneHeaderColumn';

/** A row's child that grows to `maxWidth` inside its parent's padding and is centred in what is left. */
function centredBox(
  paneWidthPx: number,
  startPx: number,
  endPx: number,
  maxWidthPx: number,
) {
  const room = paneWidthPx - startPx - endPx;
  const width = Math.min(room, maxWidthPx);
  const left = startPx + (room - width) / 2;
  return { left, right: left + width };
}

const GLYPH_INSET_PX =
  (HAPPIER_ICON_BUTTON_SIZE -
    resolveIconButtonGlyphSize(HAPPIER_ICON_BUTTON_SIZE)) /
  2;

describe('pane header content column (owner 11-08: the Session header aligns with its content)', () => {
  // A Session's composer card: its gutter on a desktop window, centred at the conversation column's width.
  const composer = (paneWidthPx: number, columnPx: number) => {
    const { paddingHorizontal } = resolveAgentInputColumn({
      screenWidth: 1440,
      maxWidthCap: columnPx,
    });
    return centredBox(
      paneWidthPx,
      paddingHorizontal,
      paddingHorizontal,
      columnPx,
    );
  };
  const header = (paneWidthPx: number, columnPx: number) =>
    centredBox(
      paneWidthPx,
      HEADER_BAND_HORIZONTAL_PADDING_PX,
      PANE_HEADER_BAND_TRAILING_PADDING_PX,
      resolvePaneHeaderColumnMaxWidthPx(columnPx),
    );

  it.each([
    [1124, 800],
    [1440, 800],
    [1920, 800],
    [1920, 960],
    [1600, 1100],
  ])(
    'title starts and the trailing glyph ends on the composer card edges (pane %i px, column %i px)',
    (pane, column) => {
      const card = composer(pane, column);
      const band = header(pane, column);
      expect(band.left).toBe(card.left);
      expect(band.right - GLYPH_INSET_PX).toBe(card.right);
    },
  );

  it('a pane no wider than the column keeps the band on its own insets', () => {
    const band = header(700, 800);
    expect(band.left).toBe(HEADER_BAND_HORIZONTAL_PADDING_PX);
    expect(band.right).toBe(700 - PANE_HEADER_BAND_TRAILING_PADDING_PX);
  });
});
