import { resolveHappierColumnCountForWidth } from '@happier-dev/plugin-ui/presentation';

/**
 * A standalone collection's grid (R6, phone-system lab `p4`): one sheet of hairline cells, each a mark, a name
 * and its state. A cell keeps room for a short name at the row-title size; the sheet holds as many as fit, about
 * three on a phone and up to six on a wide page.
 */
export const SETTINGS_COLLECTION_GRID = Object.freeze({
    maxColumns: 6,
    minCellWidthPx: 112,
    markPx: 28,
});

/** How many cells a row of the grid holds at this sheet width (cells abut: their hairlines are the gap). */
export function resolveSettingsCollectionGridColumns(sheetWidthPx: number): number {
    return resolveHappierColumnCountForWidth({
        availableWidthPx: sheetWidthPx,
        requestedColumns: SETTINGS_COLLECTION_GRID.maxColumns,
        minColumnWidthPx: SETTINGS_COLLECTION_GRID.minCellWidthPx,
        columnGapPx: 0,
    });
}
