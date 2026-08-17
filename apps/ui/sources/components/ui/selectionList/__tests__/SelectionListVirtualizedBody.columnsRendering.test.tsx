/**
 * The columned VIRTUALIZED renderer, mounted.
 *
 * `SelectionListVirtualizedBody.columns.test.ts` covers the pure grouping
 * function and nothing else, yet the body routes a columned step down this path
 * as soon as a section is virtualization-eligible — which is the shipping shape
 * of a long model list. Everything between the grouped items and the screen was
 * therefore untested: that the flat path is the one chosen at all, that an
 * `option-row` item renders as a real visual row of cells, that the set
 * positions recomputed over grouped rows still follow reading order, and that
 * the card presentation survives the trip.
 *
 * Two entry points into the same renderer are used deliberately: the real
 * `auto` threshold (>50 options) proves the ROUTING, and `virtualization:
 * 'force'` keeps the remaining cases small enough to stay fast.
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

import { View } from 'react-native';

import { SELECTION_LIST_VIRTUALIZATION_THRESHOLD } from '../_constants';

const ACCESSORY_TEST_ID = 'trailing-accessory';

/** Wide enough for two 250px columns plus the shared 12px gutter. */
const TWO_COLUMN_WIDTH_PX = 546;

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

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeStep(makeOptions(1)),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        columns: { max: 2, minColumnWidthPx: 250 },
        ...overrides,
    };
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

async function renderColumnedVirtualizedList(
    props: Partial<SelectionListProps>,
): Promise<Screen> {
    const { SelectionList } = await import('../SelectionList');
    const screen = await renderScreen(<SelectionList {...defaultProps(props)} />);
    await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
    return screen;
}

/**
 * Matched by LAYOUT, never by role: a columned pane is a grid, so these rows
 * carry `role="row"`, and matching on the role would make this helper agree
 * with whatever the a11y resolver decided instead of checking it.
 */
function columnRows(screen: Screen): ReadonlyArray<ReactTestInstance> {
    return screen.tree.root.findAll((node) => {
        if (typeof node.type !== 'string') return false;
        const style = node.props.style;
        const flat = Array.isArray(style)
            ? Object.assign({}, ...style.filter(Boolean))
            : (style as Record<string, unknown> | undefined) ?? {};
        return flat.flexDirection === 'row' && flat.alignItems === 'flex-start';
    });
}

function isDescendantOf(node: ReactTestInstance, ancestor: ReactTestInstance): boolean {
    let current: ReactTestInstance | null = node.parent;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    const parts = (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean);
    return Object.assign({}, ...(parts as Array<Record<string, unknown>>));
}

/** Option ids laid out in each visual row, in reading order. */
function optionIdsByColumnRow(
    screen: Screen,
    optionIds: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
    return columnRows(screen).map((row) => optionIds.filter((id) => {
        const wrapper = screen.findByTestId(`sl:root:option-wrapper:${id}`);
        return wrapper !== null && isDescendantOf(wrapper, row);
    }));
}

beforeEach(() => {
    legendListState.reset();
});

describe('SelectionList — columned rows through the virtualized body', () => {
    it('routes a long columned step to the flat virtualized list and lays it out in a grid', async () => {
        const optionCount = SELECTION_LIST_VIRTUALIZATION_THRESHOLD + 1;
        const screen = await renderColumnedVirtualizedList({
            rootStep: makeStep(makeOptions(optionCount)),
        });

        // The virtualized list owns the scroll here: an outer ScrollView would
        // mean the mapped path rendered instead and the grid never met the
        // virtualized renderer at all.
        expect(screen.findByTestId('sl:bodyVirtualizedList')).not.toBeNull();
        expect(screen.findByTestId('sl:bodyScroll')).toBeNull();

        // One virtualized item per VISUAL row is the whole point of grouping
        // above the backend — it is what keeps `estimatedItemSize` meaningful.
        const expectedRows = Math.ceil(optionCount / 2);
        expect(columnRows(screen)).toHaveLength(expectedRows);

        // …and the rows are really rendered, each option exactly once.
        for (let index = 0; index < optionCount; index += 1) {
            expect(screen.findAllByTestId(`sl:root:option-wrapper:m-${index}`)).toHaveLength(1);
        }

        // The trailing odd option keeps its column width rather than stretching
        // across the pane (the row is padded with a spacer cell).
        const lastRow = columnRows(screen)[expectedRows - 1];
        const lastWrapper = screen.findByTestId(`sl:root:option-wrapper:m-${optionCount - 1}`);
        expect(isDescendantOf(lastWrapper!, lastRow)).toBe(true);
        expect(lastRow.children.filter((child) => typeof child !== 'string')).toHaveLength(2);
    });

    it('pairs the options row-major and keeps a section header full width', async () => {
        const screen = await renderColumnedVirtualizedList({
            rootStep: makeStep(makeOptions(5), 'force'),
        });

        expect(optionIdsByColumnRow(screen, ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'])).toEqual([
            ['m-0', 'm-1'],
            ['m-2', 'm-3'],
            ['m-4'],
        ]);

        // The header is its own full-width item, never a cell of a grid row.
        const header = screen.findByTestId('sl:section:models:header');
        expect(header).not.toBeNull();
        for (const row of columnRows(screen)) {
            expect(isDescendantOf(header!, row)).toBe(false);
        }
    });

    it('numbers the grid cells in reading order after grouping', async () => {
        const screen = await renderColumnedVirtualizedList({
            rootStep: makeStep(makeOptions(5), 'force'),
        });

        // Grid coordinates are recomputed over the GROUPED items in this
        // renderer, so a column-major fill or a per-row restart shows up as soon
        // as the second visual row is read. (A columned pane is a grid, so the
        // option-only `aria-posinset`/`aria-setsize` are replaced by the row and
        // column indices — the same reading-order claim in grid vocabulary.)
        const rows = columnRows(screen);
        const rowIndexOf = (id: string): unknown => {
            const wrapper = screen.findByTestId(`sl:root:option-wrapper:${id}`);
            const row = rows.find((candidate) => isDescendantOf(wrapper!, candidate));
            return row?.props['aria-rowindex'];
        };
        const coordinates = ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'].map((id) => [
            rowIndexOf(id),
            screen.findByTestId(`sl:root:option-wrapper:${id}`)?.props['aria-colindex'],
        ]);
        // Row 1 is the section header row, so the option rows start at 2.
        expect(coordinates).toEqual([[2, 1], [2, 2], [3, 1], [3, 2], [4, 1]]);
        expect(screen.findByTestId('sl:body')?.props['aria-rowcount']).toBe(4);
        expect(screen.findByTestId('sl:section:models:header')?.props.role)
            .toBe('columnheader');
        // Option-only metadata must be gone, not merely unread.
        expect(screen.findByTestId('sl:root:option:m-4')?.props['aria-posinset']).toBeUndefined();
        expect(screen.findByTestId('sl:root:option:m-4')?.props['aria-setsize']).toBeUndefined();
    });

    it('is the DECLARED columns config that pulls a lone section onto the flat path', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ rootStep: makeStep(makeOptions(5), 'force') })} />,
        );

        // Too narrow for two columns — but the pane DECLARED columns, so the
        // renderer that owns visual-row grouping is already the one mounted.
        // Routing on the resolved count instead swapped the whole body subtree
        // at the breakpoint; see `SelectionList.columnRendererStability`.
        await measureContainer(screen, 420);
        expect(screen.findByTestId('sl:bodyVirtualizedList')).not.toBeNull();
        expect(screen.findByTestId('sl:section:models:virtualized')).toBeNull();
        expect(columnRows(screen)).toHaveLength(0);
        expect(screen.findByTestId('sl:root:option-wrapper:m-4')).not.toBeNull();

        // Widening it reflows the SAME renderer into two columns.
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        expect(screen.findByTestId('sl:bodyVirtualizedList')).not.toBeNull();
        expect(screen.findByTestId('sl:section:models:virtualized')).toBeNull();
        expect(columnRows(screen)).toHaveLength(3);
    });
});

/**
 * The grid ARIA pattern through the VIRTUALIZED renderer. The mapped renderer
 * is covered by `SelectionList.columnsWithExpandedContent.test.tsx`; the two
 * assign row indices from different code (a per-section offset vs. an index
 * carried on the flat row item), so a divergence between them is only visible
 * here.
 */
describe('SelectionList — grid ARIA through a virtualized columned list', () => {
    // `columnRows` is already matched by layout rather than by role, which is
    // exactly what this block needs — a second identical local helper would be
    // one more place to keep in step.
    const visualRows = columnRows;

    it('numbers visual rows and columns across the flattened list', async () => {
        const options = makeOptions(5).map((option, index) => (index === 1
            ? { ...option, expandedContent: <View testID="inline-controls" /> }
            : option));
        const screen = await renderColumnedVirtualizedList({
            rootStep: makeStep(options, 'force'),
            selectedOptionId: 'm-1',
        });

        const body = screen.findByTestId('sl:body');
        expect(body?.props.role).toBe('grid');
        // Five options in two columns are three painted rows, not five — plus
        // the section header, which is a row of the grid in its own right.
        expect(body?.props['aria-rowcount']).toBe(4);
        expect(body?.props['aria-colcount']).toBe(2);

        const rows = visualRows(screen);
        expect(rows.map((row) => row.props.role)).toEqual(['row', 'row', 'row']);
        expect(rows.map((row) => row.props['aria-rowindex'])).toEqual([2, 3, 4]);

        // Cells are the option wrappers, indexed left to right, and the open
        // panel lives inside its own option's cell rather than adding a third.
        const colIndexOf = (id: string): unknown =>
            screen.findByTestId(`sl:root:option-wrapper:${id}`)?.props['aria-colindex'];
        expect(['m-0', 'm-1', 'm-2', 'm-3', 'm-4'].map(colIndexOf)).toEqual([1, 2, 1, 2, 1]);
        const expanded = screen.findByTestId('inline-controls');
        expect(expanded).not.toBeNull();
        expect(isDescendantOf(expanded!, screen.findByTestId('sl:root:option-wrapper:m-1')!))
            .toBe(true);
        // Every row carries at least one cell and never more than the declared
        // column count, and each cell's index is inside that count. `<= 2` alone
        // passed for a row that emitted NOTHING, which is the one shape a
        // grouping bug would actually produce.
        for (const row of rows) {
            const cells = row.findAll((node) => typeof node.type === 'string'
                && node.props?.role === 'gridcell');
            expect(cells.length).toBeGreaterThanOrEqual(1);
            expect(cells.length).toBeLessThanOrEqual(2);
            expect(cells.map((cell) => cell.props['aria-colindex']))
                .toEqual(cells.map((_cell, index) => index + 1));
        }
    });

    it('spans a section too short to fill a row across every column', async () => {
        const screen = await renderColumnedVirtualizedList({
            rootStep: {
                id: 'root',
                title: 'Models',
                inputPlaceholder: 'Search models',
                sections: [
                    {
                        kind: 'static',
                        id: 'current-selection-recovery',
                        title: '',
                        options: [{
                            id: 'current',
                            label: 'Current selection',
                            expandedContent: <View testID="inline-controls" />,
                        }],
                    },
                    {
                        kind: 'static',
                        id: 'models',
                        title: 'MODELS',
                        options: makeOptions(4),
                        virtualization: 'force',
                    },
                ],
            },
            selectedOptionId: 'current',
        });

        const recoveryCell = screen.findByTestId('sl:root:option-wrapper:current');
        expect(recoveryCell?.props['aria-colindex']).toBe(1);
        // One cell that accounts for BOTH columns keeps `aria-colcount` true
        // while the card visibly spans the pane.
        expect(recoveryCell?.props['aria-colspan']).toBe(2);
        expect(screen.findByTestId('sl:root:option-wrapper:m-0')?.props['aria-colspan'])
            .toBeUndefined();
        // 1 full-width row + 2 rows of two, plus ONE header row: the recovery
        // section's title is empty, so it renders no header and takes no index,
        // while `MODELS` renders one and does.
        expect(screen.findByTestId('sl:body')?.props['aria-rowcount']).toBe(4);
        expect(visualRows(screen).map((row) => row.props['aria-rowindex'])).toEqual([1, 3, 4]);
    });
});

describe('SelectionList — card presentation inside a virtualized columned list', () => {
    function cardStep(): SelectionListStep {
        return makeStep(
            makeOptions(4).map((option) => ({
                ...option,
                rightAccessory: <View testID={`${ACCESSORY_TEST_ID}:${option.id}`} />,
                rightAccessoryOutsidePressable: true,
            })),
            'force',
        );
    }

    async function renderCards(): Promise<Screen> {
        return renderColumnedVirtualizedList({
            rootStep: cardStep(),
            selectedOptionId: 'm-1',
            optionPresentation: 'card',
        });
    }

    it('wraps each virtualized grid cell in the card envelope', async () => {
        const screen = await renderCards();
        expect(columnRows(screen)).toHaveLength(2);

        for (const id of ['m-0', 'm-1', 'm-2', 'm-3']) {
            const wrapper = screen.findByTestId(`sl:root:option-wrapper:${id}`);
            const style = flattenStyle(wrapper?.props.style);
            // Rounded, clipping, and its own positioning context — without all
            // three the corner accessory and the expanded panel escape the card.
            expect(typeof style.borderRadius).toBe('number');
            expect(style.borderRadius as number).toBeGreaterThan(0);
            expect(style.overflow).toBe('hidden');
            expect(style.position).toBe('relative');
        }

        // The selected card owns a different fill from its idle neighbours, so
        // the card really is the fill owner on this path too.
        const selectedFill = flattenStyle(
            screen.findByTestId('sl:root:option-wrapper:m-1')?.props.style,
        ).backgroundColor;
        const idleFill = flattenStyle(
            screen.findByTestId('sl:root:option-wrapper:m-0')?.props.style,
        ).backgroundColor;
        expect(selectedFill).toBeDefined();
        expect(idleFill).toBeDefined();
        expect(selectedFill).not.toBe(idleFill);
    });

    it('keeps the lifted corner accessory inside its own card cell', async () => {
        const screen = await renderCards();

        for (const id of ['m-0', 'm-1', 'm-2', 'm-3']) {
            const overlay = screen.findByTestId(`sl:root:option-card-accessory:${id}`);
            expect(overlay).not.toBeNull();
            expect(flattenStyle(overlay?.props.style).position).toBe('absolute');
            // Anchored to its OWN card, not to a shared row or the pane.
            expect(isDescendantOf(overlay!, screen.findByTestId(`sl:root:option-wrapper:${id}`)!))
                .toBe(true);
            expect(isDescendantOf(screen.findByTestId(`${ACCESSORY_TEST_ID}:${id}`)!, overlay!))
                .toBe(true);
        }

        // Each card stays within its own visual row.
        const [firstRow, secondRow] = columnRows(screen);
        expect(isDescendantOf(screen.findByTestId('sl:root:option-card-accessory:m-1')!, firstRow))
            .toBe(true);
        expect(isDescendantOf(screen.findByTestId('sl:root:option-card-accessory:m-2')!, secondRow))
            .toBe(true);
    });

    it('adds no card treatment to the same virtualized grid by default', async () => {
        const screen = await renderColumnedVirtualizedList({
            rootStep: cardStep(),
            selectedOptionId: 'm-1',
        });

        // Control for the two tests above: without the opt-in, the identical
        // virtualized columned list carries no card surface and no overlay.
        expect(columnRows(screen)).toHaveLength(2);
        expect(screen.findByTestId('sl:root:option-wrapper:m-1')?.props.style).toBeUndefined();
        expect(screen.findAllByTestId('sl:root:option-card-accessory:m-1')).toHaveLength(0);
    });
});
