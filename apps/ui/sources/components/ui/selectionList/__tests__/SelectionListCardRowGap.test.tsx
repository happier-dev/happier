/**
 * The gap between stacked CARDS, at every column count.
 *
 * `SelectionListColumnRow.cardSpacing.test.tsx` proves the gap exists on a
 * multi-column row. It cannot see the defect this file exists for: the gap was
 * a property of the multi-column WRAPPER, and there is no wrapper at one
 * column, so cards sat flush wherever the pane is narrow — every phone — and on
 * every frame before a pane has been measured, since the resolver falls to one
 * column until then. The user's report ("no margin between the cards") was that
 * state.
 *
 * So the claim under test is a comparison, not a constant: the vertical
 * separation between one card row and the next is the SAME at one column as at
 * two, through both renderers. A regression that re-attaches the gap to the
 * multi-column wrapper fails the one-column cases; a regression that leaks it
 * into the flush `row` presentation fails the control block, where a margin
 * would tear open every `ItemGroup` divider in the app.
 */

import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type {
    SelectionListOption,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

import { SELECTION_LIST_CARD_ROW_GAP_PX } from '../_constants';

/** Wide enough for two 250px columns plus the shared gutter. */
const TWO_COLUMN_WIDTH_PX = 546;
/** Room for one 250px column only. */
const ONE_COLUMN_WIDTH_PX = 420;

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function makeOptions(count: number): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, index) => ({
        id: `m-${index}`,
        label: `Model ${index}`,
    }));
}

function makeStep(
    options: ReadonlyArray<SelectionListOption>,
    virtualization?: 'force',
): SelectionListStep {
    return {
        id: 'root',
        title: 'Models',
        inputPlaceholder: 'Search models',
        sections: [{
            kind: 'static',
            id: 'models',
            title: 'MODELS',
            options,
            ...(virtualization ? { virtualization } : {}),
        }],
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    const parts = (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean);
    return Object.assign({}, ...(parts as Array<Record<string, unknown>>));
}

/** The multi-column wrappers, matched by their layout as the spacing tests do. */
function columnRows(screen: Screen): ReadonlyArray<ReactTestInstance> {
    return screen.tree.root.findAll((node) => {
        if (typeof node.type !== 'string') return false;
        const flat = flattenStyle(node.props.style);
        return flat.flexDirection === 'row' && flat.alignItems === 'flex-start';
    });
}

function wrapperStyle(screen: Screen, optionId: string): Record<string, unknown> {
    const wrapper = screen.findByTestId(`sl:root:option-wrapper:${optionId}`);
    expect(wrapper).not.toBeNull();
    return flattenStyle(wrapper?.props.style);
}

/**
 * The separation painted above the SECOND visual row — the one number the user
 * sees as "space between the cards". Read from whichever node is that row: the
 * column wrapper when there is one, the leading card's own envelope when there
 * is not.
 */
function secondRowLeadingGapPx(screen: Screen, leadingOptionId: string): unknown {
    const rows = columnRows(screen);
    if (rows.length > 0) return flattenStyle(rows[1]?.props.style).marginTop;
    return wrapperStyle(screen, leadingOptionId).marginTop;
}

async function measureContainer(screen: Screen, widthPx: number): Promise<void> {
    const root = screen.findByTestId('sl');
    const onLayout = root?.props.onLayout as ((event: unknown) => void) | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected the columned SelectionList to measure itself');
    }
    await act(async () => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 400 } } });
    });
}

type RenderParams = Readonly<{
    presentation: 'row' | 'card';
    /** Omit to leave the list unmeasured — the first frame of every mount. */
    widthPx?: number;
    /** Omit to render a list that never asked for columns at all. */
    columns?: boolean;
    virtualization?: 'force';
}>;

async function renderList(params: RenderParams): Promise<Screen> {
    const { SelectionList } = await import('../SelectionList');
    const props: SelectionListProps = {
        rootStep: makeStep(makeOptions(4), params.virtualization),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        optionPresentation: params.presentation,
        ...(params.columns === false ? {} : { columns: { max: 2, minColumnWidthPx: 250 } }),
    };
    const screen = await renderScreen(<SelectionList {...props} />);
    if (params.widthPx !== undefined) await measureContainer(screen, params.widthPx);
    return screen;
}

beforeEach(() => {
    legendListState.reset();
});

describe('SelectionList cards — the row gap survives a single column', () => {
    for (const renderer of ['mapped', 'virtualized'] as const) {
        const virtualization = renderer === 'virtualized' ? ('force' as const) : undefined;

        describe(`${renderer} renderer`, () => {
            it('separates stacked cards in a narrow pane exactly as it does in a wide one', async () => {
                const narrow = await renderList({
                    presentation: 'card',
                    widthPx: ONE_COLUMN_WIDTH_PX,
                    virtualization,
                });
                // One column: four cards stacked, so the second card leads the
                // second visual row.
                expect(columnRows(narrow)).toHaveLength(0);
                expect(secondRowLeadingGapPx(narrow, 'm-1')).toBe(SELECTION_LIST_CARD_ROW_GAP_PX);
                expect(wrapperStyle(narrow, 'm-2').marginTop).toBe(SELECTION_LIST_CARD_ROW_GAP_PX);

                const wide = await renderList({
                    presentation: 'card',
                    widthPx: TWO_COLUMN_WIDTH_PX,
                    virtualization,
                });
                expect(columnRows(wide)).toHaveLength(2);
                // The comparison the user actually sees: the same separation
                // either way, so widening the pane re-flows the grid without
                // changing how far apart the cards sit.
                expect(secondRowLeadingGapPx(wide, 'm-2'))
                    .toBe(secondRowLeadingGapPx(narrow, 'm-1'));
            });

            it('leads the popup with a flush first card', async () => {
                const screen = await renderList({
                    presentation: 'card',
                    widthPx: ONE_COLUMN_WIDTH_PX,
                    virtualization,
                });
                // Nothing above it to separate from; a margin here would push
                // every card down and open a hole under the search header.
                expect(wrapperStyle(screen, 'm-0').marginTop).toBeUndefined();
            });

            it('spaces the cards on the first frame, before the pane is measured', async () => {
                const screen = await renderList({ presentation: 'card', virtualization });
                // The resolver falls to one column until a width arrives, so an
                // unmeasured mount paints the same stack a phone does. Without
                // the gap here the cards land flush and then jump apart the
                // moment layout reports — a visible reflow on every open.
                expect(wrapperStyle(screen, 'm-0').marginTop).toBeUndefined();
                expect(wrapperStyle(screen, 'm-1').marginTop).toBe(SELECTION_LIST_CARD_ROW_GAP_PX);
            });

            it('spaces the cards of a list that never asked for columns', async () => {
                const screen = await renderList({
                    presentation: 'card',
                    columns: false,
                    virtualization,
                });
                expect(columnRows(screen)).toHaveLength(0);
                expect(wrapperStyle(screen, 'm-0').marginTop).toBeUndefined();
                expect(wrapperStyle(screen, 'm-3').marginTop).toBe(SELECTION_LIST_CARD_ROW_GAP_PX);
            });

            it('lets the visual row own the gap once there are two columns', async () => {
                const screen = await renderList({
                    presentation: 'card',
                    widthPx: TWO_COLUMN_WIDTH_PX,
                    virtualization,
                });
                // A card that is a CELL takes no margin of its own: its row
                // already carries one, and a second would double the gap.
                for (const id of ['m-0', 'm-1', 'm-2', 'm-3']) {
                    expect(wrapperStyle(screen, id).marginTop).toBeUndefined();
                }
                expect(flattenStyle(columnRows(screen)[0]?.props.style).marginTop)
                    .toBeUndefined();
                expect(flattenStyle(columnRows(screen)[1]?.props.style).marginTop)
                    .toBe(SELECTION_LIST_CARD_ROW_GAP_PX);
            });
        });
    }
});

describe('SelectionList rows — the flush presentation is untouched', () => {
    for (const renderer of ['mapped', 'virtualized'] as const) {
        const virtualization = renderer === 'virtualized' ? ('force' as const) : undefined;

        it(`adds no vertical gap at any column count (${renderer} renderer)`, async () => {
            for (const widthPx of [undefined, ONE_COLUMN_WIDTH_PX, TWO_COLUMN_WIDTH_PX]) {
                const screen = await renderList({
                    presentation: 'row',
                    ...(widthPx === undefined ? {} : { widthPx }),
                    virtualization,
                });
                for (const id of ['m-0', 'm-1', 'm-2', 'm-3']) {
                    // The flush row carries no style prop at all, which is what
                    // lets `Item` resolve the user's density exactly as it does
                    // in every other list.
                    expect(screen.findByTestId(`sl:root:option-wrapper:${id}`)?.props.style)
                        .toBeUndefined();
                }
                for (const row of columnRows(screen)) {
                    // An `ItemGroup`'s dividers assume its rows meet flush.
                    expect(flattenStyle(row.props.style).marginTop).toBeUndefined();
                }
            }
        });
    }
});
