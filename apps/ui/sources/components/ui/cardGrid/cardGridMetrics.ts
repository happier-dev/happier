import { resolveHappierColumnCountForWidth } from '@happier-dev/plugin-ui/presentation';

/**
 * The one card-grid rhythm (lab `.hi-tiles`: three columns, 10 px apart): Home's setup, usage, machines
 * and widgets, and set-up blocks wherever they appear, share edges, widths and gaps. A cell never gets
 * narrower than `minColumnWidthPx`; below that the grid drops a column, down to one on a phone.
 */
export const CARD_GRID = Object.freeze({
    columns: 3,
    gapPx: 10,
    minColumnWidthPx: 200,
});

/** How many columns a card grid of this width shows. */
export function resolveCardGridColumns(widthPx: number, requestedColumns: number = CARD_GRID.columns): number {
    return resolveHappierColumnCountForWidth({
        availableWidthPx: widthPx,
        requestedColumns,
        minColumnWidthPx: CARD_GRID.minColumnWidthPx,
        columnGapPx: CARD_GRID.gapPx,
    });
}

/**
 * The same grid drawn as one sheet of hairline cells (R6, phone-system lab `p4`): a standalone collection's
 * section (Agents), each cell a mark, a name and its state. Cells abut (their hairlines are the gap) and keep room
 * for a short name at the row-title size: about three on a phone, up to six on a wide page.
 */
export const CARD_GRID_SHEET = Object.freeze({
    maxColumns: 6,
    minCellWidthPx: 112,
    markPx: 28,
});

/** How many cells a row of a sheet grid holds at this sheet width. */
export function resolveCardGridSheetColumns(sheetWidthPx: number): number {
    return resolveHappierColumnCountForWidth({
        availableWidthPx: sheetWidthPx,
        requestedColumns: CARD_GRID_SHEET.maxColumns,
        minColumnWidthPx: CARD_GRID_SHEET.minCellWidthPx,
        columnGapPx: 0,
    });
}
