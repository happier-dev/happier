import { createContext } from 'react';

import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';

/**
 * The desktop shell's one title row (owner, 2026-11-10): the rail's first icon, every column's title (a
 * sidebar, a list column) and the page title centre on one line, the centre of the band a pane opens with
 * (`paneHeaderHeightPx`), measured from the top of the pane they head. A column title's top margin then
 * matches its left margin (`contentInset`).
 *
 * The top inset that centres a row of this height on that line.
 */
export function resolveHappierTitleRowInsetPx(rowHeightPx: number): number {
  return Math.max(
    0,
    (HAPPIER_PAGE_METRICS.paneHeaderHeightPx - rowHeightPx) / 2,
  );
}

/**
 * Whether the page heads a desktop shell pane, so its title belongs on the shell's title row. The shell
 * provides it around its panes; absent (a phone, a window without the shell) a page keeps its own top air.
 */
export const HappierShellTitleRowContext = createContext(false);
