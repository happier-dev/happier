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

// Keep the real exports: the virtualized barrel's section-list entry imports `internal` from here.
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    LegendList: capturedLegendList.LegendList,
}));

import { View } from 'react-native';

import { SELECTION_LIST_VIRTUALIZATION_THRESHOLD } from '../_constants';

// Load the real UI graph during collection; a cold transform is not row-rendering work.
const { SelectionList } = await import('../SelectionList');

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

/** Option ids stacked in each column of the first block. */
function optionIdsByColumn(
    screen: Screen,
    optionIds: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
    const [block] = columnRows(screen);
    return block.children
        .filter((child): child is ReactTestInstance => typeof child !== 'string')
        .map((column) => optionIds.filter((id) => {
            const wrapper = screen.findByTestId(`sl:root:option-wrapper:${id}`);
            return wrapper !== null && isDescendantOf(wrapper, column);
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

        // A long catalog is cut into blocks of the virtualization threshold: the backend
        // windows blocks, and inside one each column stacks on its own.
        const expectedBlocks = Math.ceil(optionCount / SELECTION_LIST_VIRTUALIZATION_THRESHOLD);
        expect(columnRows(screen)).toHaveLength(expectedBlocks);

        // …and the rows are really rendered, each option exactly once.
        for (let index = 0; index < optionCount; index += 1) {
            expect(screen.findAllByTestId(`sl:root:option-wrapper:m-${index}`)).toHaveLength(1);
        }

        // The trailing odd option keeps its column width rather than stretching
        // across the pane: its block still lays out both columns.
        const lastBlock = columnRows(screen)[expectedBlocks - 1];
        const lastWrapper = screen.findByTestId(`sl:root:option-wrapper:m-${optionCount - 1}`);
        expect(isDescendantOf(lastWrapper!, lastBlock)).toBe(true);
        expect(lastBlock.children.filter((child) => typeof child !== 'string')).toHaveLength(2);
    });

    it('keeps the flat virtualized host shrinkable below its normal four-row height', async () => {
        const screen = await renderColumnedVirtualizedList({
            rootStep: makeStep(makeOptions(5), 'force'),
        });

        const hostStyle = flattenStyle(screen.findByTestId('sl:body')?.props.style);
        expect(hostStyle.minHeight).toBe(0);
        expect(hostStyle.height).toBe(224);
        expect(hostStyle.maxHeight).toBe('100%');
    });

    it('stacks each column on its own, so an open card reserves nothing beside it', async () => {
        const options = makeOptions(5).map((option) => (option.id === 'm-1'
            ? { ...option, expandedContent: <View testID="inline-controls" /> }
            : option));
        const screen = await renderColumnedVirtualizedList({
            rootStep: makeStep(options, 'force'),
            selectedOptionId: 'm-1',
        });

        // Reading order still alternates (m-0, m-1, ...), but m-2 follows m-0 in the first
        // column whatever height m-1 grows to: no row ties them together.
        expect(optionIdsByColumnRow(screen, ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'])).toEqual([
            ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'],
        ]);
        expect(optionIdsByColumn(screen, ['m-0', 'm-1', 'm-2', 'm-3', 'm-4'])).toEqual([
            ['m-0', 'm-2', 'm-4'],
            ['m-1', 'm-3'],
        ]);

        // The header is its own full-width item, never a cell of a grid row.
        const header = screen.findByTestId('sl:section:models:header');
        expect(header).not.toBeNull();
        for (const row of columnRows(screen)) {
            expect(isDescendantOf(header!, row)).toBe(false);
        }
    });

    it('is the DECLARED columns config that pulls a lone section onto the flat path', async () => {
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
        expect(columnRows(screen)).toHaveLength(1);
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
    const gridRows = (screen: Screen): ReadonlyArray<ReactTestInstance> => screen.tree.root.findAll(
        (node) => typeof node.type === 'string' && node.props?.role === 'row'
            && node.props?.['aria-rowindex'] !== undefined
            && node.findAll((cell) => cell.props?.role === 'gridcell').length > 0,
    );

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
        // Columns stack independently, so no painted row holds two cards: each card is
        // one row of the grid, and the section header is a row in its own right.
        expect(body?.props['aria-rowcount']).toBe(6);
        expect(body?.props['aria-colcount']).toBe(2);
        expect(screen.findByTestId('sl:section:models:header')?.props.role).toBe('columnheader');
        // A columned pane is a grid: the option-only `aria-posinset`/`aria-setsize`
        // are replaced by row and column indices, gone rather than merely unread.
        expect(screen.findByTestId('sl:root:option:m-4')?.props['aria-posinset']).toBeUndefined();
        expect(screen.findByTestId('sl:root:option:m-4')?.props['aria-setsize']).toBeUndefined();

        const rows = gridRows(screen);
        expect(rows.map((row) => row.props['aria-rowindex'])).toEqual([2, 4, 6, 3, 5]);

        // Cells are the option wrappers, indexed left to right, and the open
        // panel lives inside its own option's cell rather than adding a third.
        const colIndexOf = (id: string): unknown =>
            screen.findByTestId(`sl:root:option-wrapper:${id}`)?.props['aria-colindex'];
        expect(['m-0', 'm-1', 'm-2', 'm-3', 'm-4'].map(colIndexOf)).toEqual([1, 2, 1, 2, 1]);
        const expanded = screen.findByTestId('inline-controls');
        expect(expanded).not.toBeNull();
        expect(isDescendantOf(expanded!, screen.findByTestId('sl:root:option-wrapper:m-1')!))
            .toBe(true);
        // Every row carries exactly one cell, whose index names its column.
        for (const row of rows) {
            const cells = row.findAll((node) => typeof node.type === 'string'
                && node.props?.role === 'gridcell');
            expect(cells).toHaveLength(1);
            expect([1, 2]).toContain(cells[0].props['aria-colindex']);
        }
    });

    it('gives every column the equal share, so a long card cannot widen its column', async () => {
        // Live 1440 engine pane (2026-11-03): a long Vercel model id sized its cell to its content,
        // pushing the second card past the pane's edge. Equal columns are the block's direct children.
        const options = makeOptions(4).map((option, index) => (index === 1
            ? { ...option, label: 'A very long model name that would otherwise size its own column', expandedContent: <View /> }
            : option));
        const screen = await renderColumnedVirtualizedList({
            rootStep: makeStep(options, 'force'),
            selectedOptionId: 'm-1',
        });

        const rows = visualRows(screen);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            const cells = row.children.filter((child): child is ReactTestInstance => typeof child !== 'string');
            expect(cells).toHaveLength(2);
            for (const cell of cells) {
                // The host node that the row lays out (a composite resolves to its first host).
                const host = typeof cell.type === 'string' ? cell : cell.findAll((node) => typeof node.type === 'string')[0]!;
                expect(flattenStyle(host.props.style)).toMatchObject({ flexBasis: 0, flexGrow: 1, minWidth: 0 });
            }
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
        // 1 full-width row + 4 cards, plus ONE header row: the recovery section's
        // title is empty, so it renders no header and takes no index, while
        // `MODELS` renders one and does.
        expect(screen.findByTestId('sl:body')?.props['aria-rowcount']).toBe(6);
        expect(gridRows(screen).map((row) => row.props['aria-rowindex'])).toEqual([1, 3, 5, 4, 6]);
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
        expect(columnRows(screen)).toHaveLength(1);

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

    });

    it('adds no card treatment to the same virtualized grid by default', async () => {
        const screen = await renderColumnedVirtualizedList({
            rootStep: cardStep(),
            selectedOptionId: 'm-1',
        });

        // Control for the two tests above: without the opt-in, the identical
        // virtualized columned list carries no card surface and no overlay.
        expect(columnRows(screen)).toHaveLength(1);
        expect(screen.findByTestId('sl:root:option-wrapper:m-1')?.props.style).toBeUndefined();
        expect(screen.findAllByTestId('sl:root:option-card-accessory:m-1')).toHaveLength(0);
    });
});
