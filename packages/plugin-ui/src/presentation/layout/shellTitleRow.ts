import { createContext } from 'react';

import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';

/**
 * The desktop shell's one title row (owner, 2026-11-10): the rail's first icon, every column's title (a
 * sidebar, a list column) and the page title centre on one line, the centre of the band a pane opens with
 * (`paneHeaderHeightPx`), measured from the top of the pane they head. A column title's top margin then
 * matches its left margin (`contentInset`). A title then rises by `resolveHappierTitleRowTitleLiftPx`.
 *
 * The top inset that centres a row of this height on that line.
 */
export function resolveHappierTitleRowInsetPx(rowHeightPx: number): number {
  return Math.max(
    0,
    (HAPPIER_PAGE_METRICS.paneHeaderHeightPx - rowHeightPx) / 2,
  );
}

/** The glyph the title row centres: the rail's icons and the row's controls draw at this size. */
export const HAPPIER_SHELL_TITLE_ROW_GLYPH_PX = 20;

/** The icon family's ink starts this far inside its box (24 of 256 units). */
const GLYPH_INK_INSET_EM = 24 / 256;
/** Inter, the UI face: ascent, descent and cap height in em. */
const UI_FACE = { ascent: 0.96875, descent: 0.2421875, capHeight: 0.727 } as const;

/**
 * How far a title on the row rises from centred so its capitals start where the row glyph's ink does (owner,
 * 2026-11-11: "My work" on the line from the top of the rail's first icon). The glyphs stay centred; a title
 * whose capitals are shorter than the glyph's ink would otherwise start below it. Whole pixels, so text stays crisp.
 */
export function resolveHappierTitleRowTitleLiftPx(fontSizePx: number): number {
  const glyphInkTopAboveCentre = HAPPIER_SHELL_TITLE_ROW_GLYPH_PX * (0.5 - GLYPH_INK_INSET_EM);
  // A line's content box centres in its line box, so the capitals' top sits this far above the line's centre.
  const capTopAboveCentre = fontSizePx * (UI_FACE.capHeight - (UI_FACE.ascent - UI_FACE.descent) / 2);
  return Math.max(0, Math.round(glyphInkTopAboveCentre - capTopAboveCentre));
}

/**
 * Whether the page heads a desktop shell pane, so its title belongs on the shell's title row. The shell
 * provides it around its panes; absent (a phone, a window without the shell) a page keeps its own top air.
 */
export const HappierShellTitleRowContext = createContext(false);

/**
 * A page header whose title line its container already places level with a neighbouring row (an Add dialog's
 * details beside the list's search, owner 2026-11-11): the header adds no top air of its own.
 */
export const HappierPageHeaderFlushTopContext = createContext(false);
