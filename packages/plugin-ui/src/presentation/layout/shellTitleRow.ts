import { createContext } from 'react';

import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';

/**
 * The desktop shell's one title row (owner, 2026-11-10): the rail's first icon, every column's title (a
 * sidebar, a list column) and the page title centre on one line, the centre of the band a pane opens with
 * (`paneHeaderHeightPx`), measured from the top of the pane they head. A column title's top margin then
 * matches its left margin (`contentInset`). The title, its controls and the rail's icon all centre on it (owner
 * 2026-11-16, r2 item 2).
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

/**
 * The rail's step: one rail item and the gap to the next, centre to centre. A column's rhythm reads it (owner
 * 2026-11-16, r2 item 3): its first row stands one step under the title row, on the rail's second icon, and a group
 * label one step under the row before it, so the header gap and the gap between sections are one gap.
 */
export const HAPPIER_SHELL_RAIL_STEP_PX = 40;

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
