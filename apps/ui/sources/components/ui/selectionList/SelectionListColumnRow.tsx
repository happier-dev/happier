/**
 * One BLOCK of the SelectionList `columns` variant: its options laid out as
 * independent column stacks (0.2's model grid, approved by the owner).
 *
 * Shared by the mapped row path (`PlanSuccessRows`) and the virtualized path
 * (`SelectionListVirtualizedBody`) so a block is laid out identically no matter
 * which renderer produced it.
 *
 * Choices worth stating:
 *
 *  - Columns, never rows. An option goes to column `index % columnCount`, so
 *    reading order still alternates while each column stacks on its own: the
 *    open card grows its own column and reserves nothing beside it. A row-based
 *    grid made the card's idle neighbour sit above empty pane (owner, 11-05).
 *
 *  - A last column that is shorter keeps its width: the block always lays out
 *    every column. A section too SHORT to fill a row is a different case and is
 *    resolved before this component sees it — see
 *    `resolveSelectionListSectionColumnCount`, which hands such a section a
 *    `columnCount` of 1 so its card genuinely spans the pane.
 *
 *  - Spacing follows the option PRESENTATION, not the column count. A `card`
 *    grid separates its cards — a tight gutter sideways and a larger gap between
 *    stacked cards, since horizontal neighbours are already held apart by two
 *    card edges while vertical ones meet flush. A `row` grid keeps the shared
 *    list gutter and no vertical gap at all, because its rows are divided by an
 *    `ItemGroup` divider that a gap would tear open.
 *
 *  - In `grid` mode each card is one `role="row"` holding its one gridcell,
 *    numbered in reading order, since no painted row holds two cards. In
 *    `listbox` mode the wrappers are pure layout and remove themselves with
 *    `role="presentation"`. (A single-column list has no
 *    `SelectionListColumnRow` at all; there the option wrapper is still the row.)
 */

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ITEM_GROUP_COLUMN_GAP_PX } from '@/components/ui/lists/itemGroupColumnLayout';

import { buildSelectionListRowA11yProps } from './buildSelectionListOptionA11yProps';
import {
    SELECTION_LIST_CARD_COLUMN_GAP_PX,
    SELECTION_LIST_CARD_ROW_GAP_PX,
    SELECTION_LIST_VIRTUALIZATION_THRESHOLD,
} from './_constants';
import { SelectionListA11yPatternContext } from './SelectionListA11yPatternContext';
import { SelectionListOptionPresentationContext } from './SelectionListOptionPresentationContext';
import { SelectionListScrollOffsetFrame } from './SelectionListScrollOffsetFrame';

const stylesheet = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    column: {
        // Equal columns regardless of intrinsic content width. `minWidth: 0`
        // is what actually lets a long model name ellipsize instead of forcing
        // its column wider than its share.
        flexBasis: 0,
        flexGrow: 1,
        minWidth: 0,
    },
    cardColumn: {
        rowGap: SELECTION_LIST_CARD_ROW_GAP_PX,
    },
}));

export const selectionListColumnRowStyles = stylesheet;

/**
 * The leading gap that separates one CARD block from the block above it.
 *
 * It lives in a function rather than inline below because a card row is not
 * always this component. At one column — every phone, every narrow pane, and
 * every frame before a pane has been measured, since the column resolver falls
 * to one until a width arrives — there is no column wrapper at all and the
 * option's own card envelope IS the row. Both nodes ask this one function, so
 * the single-column stack cannot drift apart from the two-column grid.
 *
 * The gap is a LEADING margin rather than a trailing one, and rather than a
 * `rowGap` on some parent: the mapped renderer returns blocks as siblings of a
 * fragment while the virtualized renderer hands each one to the list as its own
 * item, so no single parent spaces both.
 *
 * `rowIndex` is the block's 1-based position among the popup's OPTION blocks (at
 * one column, the option's position in the set) — never its `aria-rowindex`,
 * which also counts section header rows. Block 1 leads the popup and has
 * nothing above it to separate from. Popup-wide numbering is deliberate: a
 * section's first block is correctly still separated from the section above it.
 * A block with no index — a story surface or a unit harness building one
 * directly — cannot know whether it leads, and guessing would strand 8px above
 * a lone block.
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
    /** Cell contents in reading order. */
    children: ReadonlyArray<React.ReactNode>;
    columnCount: number;
    /** Defaults to the shared list-column gutter. */
    columnGapPx?: number;
    /**
     * 1-based `aria-rowindex` of this block's first card among ALL the popup's
     * grid rows, section header rows included; the cards after it follow in
     * reading order. Required in the `grid` pattern; ignored in `listbox` mode,
     * where the wrappers are presentational.
     */
    rowIndex?: number;
    /**
     * 1-based index among the popup's OPTION blocks only — what the card gap
     * asks about, because the gap separates a card from the card above it and a
     * section header is not a card. Defaults to `rowIndex` for a harness that
     * builds a block directly and has no headers to skip.
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
    const pattern = React.useContext(SelectionListA11yPatternContext);
    const columnCount = Math.max(1, Math.floor(props.columnCount));
    return (
        <SelectionListScrollOffsetFrame
            style={[
                styles.row,
                { columnGap: gapPx },
                rowGapPx === undefined ? null : { marginTop: rowGapPx },
            ]}
            role={pattern === 'grid' ? undefined : 'presentation'}
        >
            {Array.from({ length: columnCount }, (_, column) => (
                <View
                    key={`column-${column}`}
                    role={pattern === 'grid' ? undefined : 'presentation'}
                    style={[styles.column, isCard ? styles.cardColumn : null]}
                >
                    {props.children.flatMap((cell, index) => {
                        if (index % columnCount !== column) return [];
                        const rowAria = props.rowIndex === undefined
                            ? null
                            : buildSelectionListRowA11yProps({ pattern, rowIndex: props.rowIndex + index });
                        return [(
                            <SelectionListScrollOffsetFrame
                                key={`cell-${index}`}
                                style={null}
                                role={rowAria === null ? 'presentation' : rowAria.role}
                                {...(rowAria === null
                                    ? {}
                                    : { ariaProps: { 'aria-rowindex': rowAria['aria-rowindex'] } })}
                            >
                                {cell}
                            </SelectionListScrollOffsetFrame>
                        )];
                    })}
                </View>
            ))}
        </SelectionListScrollOffsetFrame>
    );
}

/**
 * Cut one section's options into column blocks, in reading order.
 *
 * Each block is one virtualized item, so a long catalog stays windowed: a window
 * mounts at most the blocks it overlaps. The block size is the threshold at which
 * a section virtualizes at all, rounded down to whole rows, so every list a mapped
 * renderer would have mounted whole is one block with no boundary in it. At a
 * boundary the columns realign below the taller one.
 */
export function chunkIntoColumnBlocks<T>(
    items: ReadonlyArray<T>,
    columnCount: number,
): ReadonlyArray<ReadonlyArray<T>> {
    const count = Math.max(1, Math.floor(columnCount));
    const size = Math.max(count, Math.floor(SELECTION_LIST_VIRTUALIZATION_THRESHOLD / count) * count);
    const blocks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        blocks.push(items.slice(index, index + size));
    }
    return blocks;
}
