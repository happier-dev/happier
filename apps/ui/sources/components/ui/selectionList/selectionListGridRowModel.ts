/**
 * The popup's GRID ROW MODEL — the one walk that decides what a row is, how
 * many there are, and what each one's `aria-rowindex` is.
 *
 * It exists because four renderers emit rows and every one of them used to
 * count independently: the mapped path derived per-section offsets, the flat
 * virtualized path carried an index on the row item, the single-column path
 * borrowed `aria-posinset`, and the container derived `aria-rowcount` from the
 * option total. That was survivable only while a row could contain nothing but
 * options. It stopped being survivable the moment SECTION HEADERS became rows
 * (see `buildSelectionListSectionHeaderGridA11yProps`): a header takes an index
 * from the same sequence, so any renderer that numbers its own rows now numbers
 * them differently from the container that counts them, and a grid whose
 * indices disagree with its `aria-rowcount` is worse than one with neither.
 *
 * The input is the FLATTENED, COLUMN-GROUPED item list the virtualized path
 * already builds — the only representation that sees every rendered element of
 * every section in painting order, at the resolved column count. Deriving the
 * model from it rather than from the plan is what stops the row numbering from
 * drifting away from the rows actually painted.
 *
 * What counts as a row:
 *  - a section header that renders (a header with no title renders nothing, so
 *    it is not a row);
 *  - one `option` item (single column) or one `option-row` item (columned).
 *
 * What does not: skeletons, error / not-found / empty-hint rows. They are
 * section-level status content, not options, and they are unreachable in grid
 * mode today — no caller combines dynamic sections with declared columns or
 * declared inline row controls. Numbering them as rows would put non-option
 * content into the grid's row sequence with nothing to say about its cells.
 */

import type { SelectionListBodyVirtualizedItem } from './SelectionListVirtualizedBody';

/**
 * Two numbers, because two different questions are asked of a row.
 *
 * `rowIndex` is `aria-rowindex`: a position among ALL grid rows, header rows
 * included, which is what the ARIA vocabulary means by a row.
 *
 * `optionRowIndex` is a position among the PAINTED OPTION rows only, and it
 * answers the card spacing question — a card is separated from the card above
 * it, and a section header is not a card. Feeding the ARIA index into that
 * decision opens an 8px hole under the first section header, because the first
 * card row stops being row 1 the moment the header takes that index.
 */
export type SelectionListGridRowPlacement = Readonly<{
    rowIndex: number;
    optionRowIndex: number;
}>;

export type SelectionListGridRowModel = Readonly<{
    /** `aria-rowcount` — every row in the grid, header rows included. */
    rowCount: number;
    /** `aria-rowindex` of each rendered section header row. */
    headerRowIndexBySectionId: ReadonlyMap<string, number>;
    /** Placement of each option row by item `rowKey`, for the flat renderer. */
    optionRowPlacementByRowKey: ReadonlyMap<string, SelectionListGridRowPlacement>;
    /**
     * Rows preceding a section's FIRST option row, in both numberings. The
     * mapped renderer numbers a section's rows from these, because it walks one
     * section at a time and cannot see the popup-wide sequence.
     */
    optionRowOffsetBySectionId: ReadonlyMap<string, SelectionListGridRowPlacement>;
}>;

export function buildSelectionListGridRowModel(
    items: ReadonlyArray<SelectionListBodyVirtualizedItem>,
): SelectionListGridRowModel {
    const headerRowIndexBySectionId = new Map<string, number>();
    const optionRowPlacementByRowKey = new Map<string, SelectionListGridRowPlacement>();
    const optionRowOffsetBySectionId = new Map<string, SelectionListGridRowPlacement>();
    let rowCount = 0;
    let optionRowCount = 0;
    for (const item of items) {
        if (item.kind === 'section-header') {
            // `SelectionListSectionHeader` renders nothing without a title, and
            // an unrendered header is not a row.
            if (item.title === undefined || item.title.length === 0) continue;
            rowCount += 1;
            headerRowIndexBySectionId.set(item.sectionId, rowCount);
            continue;
        }
        if (item.kind !== 'option' && item.kind !== 'option-row') continue;
        if (!optionRowOffsetBySectionId.has(item.sectionId)) {
            optionRowOffsetBySectionId.set(item.sectionId, {
                rowIndex: rowCount,
                optionRowIndex: optionRowCount,
            });
        }
        rowCount += 1;
        optionRowCount += 1;
        optionRowPlacementByRowKey.set(item.rowKey, {
            rowIndex: rowCount,
            optionRowIndex: optionRowCount,
        });
    }
    return {
        rowCount,
        headerRowIndexBySectionId,
        optionRowPlacementByRowKey,
        optionRowOffsetBySectionId,
    };
}
