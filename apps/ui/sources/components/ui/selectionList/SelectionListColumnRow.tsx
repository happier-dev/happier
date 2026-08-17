/**
 * One VISUAL row of the SelectionList `columns` variant.
 *
 * Shared by the mapped row path (`PlanSuccessRows`) and the virtualized path
 * (`SelectionListVirtualizedBody`) so a grid row is laid out identically no
 * matter which renderer produced it.
 *
 * Three choices worth stating:
 *
 *  - `alignItems: 'flex-start'`. DELIBERATE, and re-examined: the open card
 *    sets its row's height, its idle neighbour keeps its own and sits against
 *    the row's top edge with empty pane below it, and every row after this one
 *    is pushed down by the full height of the expanded panel. Stretching
 *    instead would drag the neighbour to the open card's height and make an
 *    idle card look like it were also open — a worse lie, and the shift below
 *    would be identical either way. What the user sees when they select a card
 *    is: that card grows in place, its neighbour stays the size it was, and the
 *    rows underneath slide down together. Only one card is ever open, so the
 *    ragged bottom edge exists on exactly one row at a time.
 *
 *  - Trailing spacers. A last row that is not full keeps its cards at column
 *    width instead of letting a lone card stretch across the pane and read as
 *    a different, wider kind of row. A section too SHORT to fill a row is a
 *    different case and is resolved before this component sees it — see
 *    `resolveSelectionListSectionColumnCount`, which hands such a section a
 *    `columnCount` of 1 so its card genuinely spans the pane.
 *
 *  - Spacing follows the option PRESENTATION, not the column count. A `card`
 *    grid separates its cards — a tight gutter sideways and a larger leading
 *    margin between stacked rows, since horizontal neighbours are already held
 *    apart by two card edges while vertical ones meet flush. A `row` grid keeps
 *    the shared list gutter and no vertical gap at all, because its rows are
 *    divided by an `ItemGroup` divider that a gap would tear open.
 *
 *  - The row's ARIA role follows the popup pattern. In `listbox` mode the
 *    visual row is pure layout and removes itself with `role="presentation"`.
 *    In `grid` mode it IS the row — `role="row"` plus its `aria-rowindex` —
 *    because a grid row holding several options is the only truthful reading
 *    of what is on screen. (A single-column list has no `SelectionListColumnRow`
 *    at all; there the option wrapper is still the row.)
 */

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ITEM_GROUP_COLUMN_GAP_PX } from '@/components/ui/lists/itemGroupColumnLayout';

import { buildSelectionListRowA11yProps } from './buildSelectionListOptionA11yProps';
import {
    SELECTION_LIST_CARD_COLUMN_GAP_PX,
    SELECTION_LIST_CARD_ROW_GAP_PX,
} from './_constants';
import { SelectionListA11yPatternContext } from './SelectionListA11yPatternContext';
import { SelectionListOptionPresentationContext } from './SelectionListOptionPresentationContext';
import { SelectionListScrollOffsetFrame } from './SelectionListScrollOffsetFrame';

const stylesheet = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    cell: {
        // Equal columns regardless of intrinsic content width. `minWidth: 0`
        // is what actually lets a long model name ellipsize instead of forcing
        // its column wider than its share.
        flexBasis: 0,
        flexGrow: 1,
        minWidth: 0,
    },
}));

export const selectionListColumnRowStyles = stylesheet;

/**
 * The leading gap that separates one CARD row from the row above it.
 *
 * It lives in a function rather than inline below because a card row is not
 * always this component. At one column — every phone, every narrow pane, and
 * every frame before a pane has been measured, since the column resolver falls
 * to one until a width arrives — there is no column wrapper at all and the
 * option's own card envelope IS the row. Both nodes ask this one function, so
 * the single-column stack cannot drift apart from the two-column grid; that
 * drift is exactly the defect this replaced, where the gap belonged to the
 * wrapper and simply vanished wherever the wrapper did.
 *
 * The gap is a LEADING margin rather than a trailing one, and rather than a
 * `rowGap` on some parent: the mapped renderer returns rows as siblings of a
 * fragment while the virtualized renderer hands each one to the list as its own
 * item, so no single parent spaces both.
 *
 * `rowIndex` is the row's 1-based position among the popup's OPTION rows (at
 * one column, the option's position in the set) — never its `aria-rowindex`,
 * which also counts section header rows. Row 1 leads the popup and has
 * nothing above it to separate from. Popup-wide numbering is deliberate: a
 * section's first row is correctly still separated from the section above it.
 * A row with no index — a story surface or a unit harness building one
 * directly — cannot know whether it leads, and guessing would strand 8px above
 * a lone row.
 *
 * A `row` presentation always gets nothing: its rows are divided by an
 * `ItemGroup` divider that a gap would tear open.
 */
export function resolveSelectionListCardRowGapPx(params: Readonly<{
    isCard: boolean;
    rowIndex: number | undefined;
}>): number | undefined {
    if (!params.isCard) return undefined;
    if (params.rowIndex === undefined || params.rowIndex <= 1) return undefined;
    return SELECTION_LIST_CARD_ROW_GAP_PX;
}

export function SelectionListColumnRow(props: Readonly<{
    /** Cell contents in reading order. Never longer than `columnCount`. */
    children: ReadonlyArray<React.ReactNode>;
    columnCount: number;
    /** Defaults to the shared list-column gutter. */
    columnGapPx?: number;
    /**
     * 1-based index of this visual row among ALL the popup's grid rows, section
     * header rows included. Required in the `grid` pattern (it becomes
     * `aria-rowindex`); ignored in `listbox` mode, where the row is
     * presentational.
     */
    rowIndex?: number;
    /**
     * 1-based index among the popup's OPTION rows only — what the card row gap
     * asks about, because the gap separates a card from the card above it and a
     * section header is not a card. Defaults to `rowIndex` for a harness that
     * builds a row directly and has no headers to skip.
     */
    optionRowIndex?: number;
}>): React.ReactElement {
    const styles = stylesheet;
    // Cards are separated from one another; flush rows are divided by an
    // `ItemGroup` divider that a gap would tear open. So the tighter gutter and
    // the vertical gap below are card-only, and the `row` presentation keeps
    // exactly the geometry it has always painted.
    const isCard = React.useContext(SelectionListOptionPresentationContext) === 'card';
    const gapPx = props.columnGapPx
        ?? (isCard ? SELECTION_LIST_CARD_COLUMN_GAP_PX : ITEM_GROUP_COLUMN_GAP_PX);
    const rowGapPx = resolveSelectionListCardRowGapPx({
        isCard,
        rowIndex: props.optionRowIndex ?? props.rowIndex,
    });
    const spacerCount = Math.max(0, props.columnCount - props.children.length);
    const pattern = React.useContext(SelectionListA11yPatternContext);
    const rowAria = props.rowIndex === undefined
        ? null
        : buildSelectionListRowA11yProps({ pattern, rowIndex: props.rowIndex });
    // A grid row owns its cells directly. These per-column layout boxes sit
    // between the row and the option wrapper that carries `role="gridcell"`, so
    // without this they would be generic elements standing between a row and
    // the cells it declares. `presentation` removes only their own semantics —
    // everything inside, including the focusable control, is untouched.
    const layoutCellRole = rowAria === null ? undefined : ('presentation' as const);
    return (
        <SelectionListScrollOffsetFrame
            style={[
                styles.row,
                { columnGap: gapPx },
                rowGapPx === undefined ? null : { marginTop: rowGapPx },
            ]}
            role={rowAria === null ? 'presentation' : rowAria.role}
            {...(rowAria === null
                ? {}
                : { ariaProps: { 'aria-rowindex': rowAria['aria-rowindex'] } })}
        >
            {props.children.map((cell, index) => (
                <View key={`cell-${index}`} style={styles.cell} role={layoutCellRole}>
                    {cell}
                </View>
            ))}
            {/*
              * A trailing spacer holds a real column of the row — it is the
              * reason the last card keeps its column width instead of stretching
              * across the pane. Leaving it role-free made the row declare fewer
              * cells than `aria-colcount`, so "3 options at 2 columns" announced
              * a second row containing one cell of a two-column grid. It is an
              * EMPTY CELL rather than an `aria-colspan` on the neighbour: the
              * card visibly does not stretch, and a colspan would describe a
              * layout that is not on screen.
              */}
            {Array.from({ length: spacerCount }, (_, index) => (
                <View
                    key={`spacer-${index}`}
                    style={styles.cell}
                    {...(rowAria === null
                        ? {}
                        : ({
                            role: 'gridcell',
                            'aria-colindex': props.children.length + index + 1,
                        } as unknown as Record<string, never>))}
                />
            ))}
        </SelectionListScrollOffsetFrame>
    );
}

/**
 * Chunk items ROW-MAJOR (`1 2 | 3 4 | 5 6`).
 *
 * Row-major, not the column-major fill a masonry layout would use: linear
 * arrow roving and `aria-posinset` both follow reading order, and this repo's
 * `ItemGroup` already refuses to combine column-major stacks with roving focus
 * for exactly that reason.
 */
export function chunkIntoColumnRows<T>(
    items: ReadonlyArray<T>,
    columnCount: number,
): ReadonlyArray<ReadonlyArray<T>> {
    const count = Math.max(1, Math.floor(columnCount));
    const rows: T[][] = [];
    for (let index = 0; index < items.length; index += count) {
        rows.push(items.slice(index, index + count));
    }
    return rows;
}
