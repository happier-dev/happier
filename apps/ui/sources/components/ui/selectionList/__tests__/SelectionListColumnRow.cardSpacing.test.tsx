/**
 * Card-grid spacing — the gutter between cards and the gap between card rows.
 *
 * The reported defect was that stacked cards butt together with no visible
 * separation while each card's own padding reads as too generous, so the grid
 * looks like one undifferentiated slab. Both halves of that are spacing the
 * ROW owns, and both are asserted here against the `row` presentation, which
 * must stay byte-identical: a gap that leaked into the flush list would tear
 * apart every `ItemGroup` in the app.
 *
 * The vertical gap cannot live on a parent, because the two renderers that
 * emit these rows do not share one: the mapped path returns a fragment of
 * sibling rows while the virtualized path hands each row to the list as its
 * own item. `SelectionListColumnRow` is the single node both produce, so the
 * gap is its own leading margin — suppressed on the popup's FIRST row, which
 * has nothing above it to separate from.
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionListColumnRow } from '../SelectionListColumnRow';
import { SelectionListOptionPresentationContext } from '../SelectionListOptionPresentationContext';
import {
    SELECTION_LIST_CARD_COLUMN_GAP_PX,
    SELECTION_LIST_CARD_ROW_GAP_PX,
} from '../_constants';
import { ITEM_GROUP_COLUMN_GAP_PX } from '@/components/ui/lists/itemGroupColumnLayout';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

type TestNode = { type: unknown; props: Record<string, unknown> };

function flatten(style: unknown): Record<string, unknown> {
    const parts = (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean);
    return Object.assign({}, ...(parts as Array<Record<string, unknown>>));
}

async function renderRow(params: Readonly<{
    presentation: 'row' | 'card';
    rowIndex?: number;
    columnGapPx?: number;
}>): Promise<Record<string, unknown>> {
    const screen = await renderScreen(
        <SelectionListOptionPresentationContext.Provider value={params.presentation}>
            <SelectionListColumnRow
                columnCount={2}
                rowIndex={params.rowIndex}
                columnGapPx={params.columnGapPx}
            >
                {[<React.Fragment key="a">a</React.Fragment>, <React.Fragment key="b">b</React.Fragment>]}
            </SelectionListColumnRow>
        </SelectionListOptionPresentationContext.Provider>,
    );
    // The row is the only node laid out as the grid row itself; matching on its
    // geometry rather than adding a production testID for the test's benefit.
    const matches = screen.root.findAll((node: TestNode) => {
        if (typeof node.type !== 'string') return false;
        const flat = flatten(node.props.style);
        return flat.flexDirection === 'row' && flat.alignItems === 'flex-start';
    });
    expect(matches).toHaveLength(1);
    return flatten((matches[0] as unknown as TestNode).props.style);
}

describe('SelectionListColumnRow — the flush row presentation is untouched', () => {
    it('keeps the shared list gutter and adds no vertical gap at any row index', async () => {
        for (const rowIndex of [1, 2, 7]) {
            const style = await renderRow({ presentation: 'row', rowIndex });
            expect(style.columnGap).toBe(ITEM_GROUP_COLUMN_GAP_PX);
            // A margin here would push apart the rows of an ItemGroup, whose
            // dividers assume its rows are flush.
            expect(style.marginTop).toBeUndefined();
        }
    });
});

describe('SelectionListColumnRow — card grid spacing', () => {
    it('tightens the gutter between cards', async () => {
        const style = await renderRow({ presentation: 'card', rowIndex: 1 });
        expect(style.columnGap).toBe(SELECTION_LIST_CARD_COLUMN_GAP_PX);
        // The two defaults must differ, or "uses the card gutter" would be
        // satisfied by an implementation that never branched at all.
        expect(SELECTION_LIST_CARD_COLUMN_GAP_PX).not.toBe(ITEM_GROUP_COLUMN_GAP_PX);
    });

    it('separates stacked card rows without indenting the first one', async () => {
        expect((await renderRow({ presentation: 'card', rowIndex: 1 })).marginTop)
            .toBeUndefined();
        expect((await renderRow({ presentation: 'card', rowIndex: 2 })).marginTop)
            .toBe(SELECTION_LIST_CARD_ROW_GAP_PX);
        expect((await renderRow({ presentation: 'card', rowIndex: 5 })).marginTop)
            .toBe(SELECTION_LIST_CARD_ROW_GAP_PX);
    });

    it('adds no gap to a row that was never given a position', async () => {
        // Story surfaces and unit harnesses build a row directly. Without an
        // index there is no way to know whether it leads the popup, and
        // guessing would put a stray 8px above a lone row.
        expect((await renderRow({ presentation: 'card' })).marginTop).toBeUndefined();
    });

    it('still lets a caller override the gutter it sized its columns against', async () => {
        const style = await renderRow({ presentation: 'card', rowIndex: 2, columnGapPx: 32 });
        expect(style.columnGap).toBe(32);
        // The vertical gap is not a caller concern and survives the override.
        expect(style.marginTop).toBe(SELECTION_LIST_CARD_ROW_GAP_PX);
    });
});
