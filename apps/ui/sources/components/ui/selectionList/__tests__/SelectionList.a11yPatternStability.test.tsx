/**
 * The popup's ARIA pattern is a CAPABILITY THE CALLER DECLARES. Nothing that
 * moves while the popup is open may reach it.
 *
 * Three implementations were tried here and two of them shipped a role set that
 * flipped mid-interaction, each refuted by a render probe:
 *
 *  1. Keyed on `expandedContent` in the FILTERED plan → flipped to `listbox`
 *     the first time a query excluded the selected (expanded) option.
 *  2. Keyed on `expandedContent` in the DECLARED sections → still flipped,
 *     because the shipped producer rebuilds its declared sections from the
 *     current selection, so "declared" was itself selection-derived.
 *  3. Keyed on the RESOLVED `columnCount` → flipped twice more: the count is
 *     `1` until `onLayout` measures, so every columned pane opened as a
 *     `listbox` and was promoted to `grid` one frame later, and it fell back
 *     again on any resize across the column threshold.
 *
 * A composite widget that changes pattern while it is open makes a screen
 * reader re-announce the entire structure, so each of those is a defect on its
 * own. The four blocks below are the four things that must NOT move it —
 * layout, selection, filtering, resize — and each re-renders the SAME mounted
 * popup rather than mounting a fresh one, because mounting fresh is exactly
 * what hid these defects.
 *
 * The last block is the identity guard: everything else in the app declares
 * neither capability, and that markup must stay what it has always been.
 */

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListOption, SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { Pressable } from 'react-native';

const EXPANDED_TEST_ID = 'inline-controls';

/** Wide enough for two 250px columns plus the shared 12px gutter. */
const TWO_COLUMN_WIDTH_PX = 546;
/** Too narrow for a second 250px column — the resolver falls back to one. */
const ONE_COLUMN_WIDTH_PX = 420;

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function makeStep(options: ReadonlyArray<SelectionListOption>): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [{ kind: 'static', id: 'models', title: 'MODELS', options }],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeStep([{ id: 'm-0', label: 'Alpha' }]),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

/** The container's own measured width is the only signal the column resolver reads. */
async function measureContainer(screen: Screen, widthPx: number): Promise<void> {
    const onLayout = screen.findByTestId('sl')?.props.onLayout as
        | ((event: unknown) => void)
        | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected the columned SelectionList to measure itself');
    }
    await act(async () => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 400 } } });
    });
}

function bodyRole(screen: Screen): unknown {
    return screen.findByTestId('sl:body')?.props.role;
}

/**
 * HOST elements only. A composite that forwards `role` down to its own host
 * View (`SelectionListScrollOffsetFrame` does) otherwise matches twice, and the
 * duplicate would silently satisfy a count.
 */
function hasHostRole(node: { type: unknown; props?: Record<string, unknown> }, role: string): boolean {
    return typeof node.type === 'string' && node.props?.role === role;
}

function countRole(screen: Screen, role: string): number {
    return screen.tree.root.findAll((node) => hasHostRole(node, role)).length;
}

/**
 * Rows of the LIVE body. `SelectionList`'s measure host also mounts an
 * identity-free mirror of the same plan; it is `aria-hidden`, but its column
 * wrappers still lay out as rows, so a whole-tree query double-counts.
 *
 * A grid's rows include its SECTION HEADER rows — a header renders text, and
 * text may not sit in a grid outside a row. `optionRows` drops them so the
 * cell-shape assertions below stay about options.
 */
function bodyRows(screen: Screen): ReturnType<Screen['findAll']> {
    const body = screen.findByTestId('sl:body');
    if (!body) throw new Error('expected a rendered body');
    return body.findAll((node) => hasHostRole(node, 'row'));
}

function optionRows(screen: Screen): ReturnType<Screen['findAll']> {
    return bodyRows(screen).filter(
        (row) => row.findAll((node) => hasHostRole(node, 'columnheader')).length === 0,
    );
}

/** The whole role set in one value, so a partial flip cannot slip through. */
function roleCensus(screen: Screen): Record<string, number> {
    return {
        listbox: countRole(screen, 'listbox'),
        option: countRole(screen, 'option'),
        grid: countRole(screen, 'grid'),
        haspopup: screen.findByTestId('sl:header:input')?.props['aria-haspopup'] === 'grid' ? 1 : 0,
    };
}

/**
 * The shipped picker's shape: the SELECTED option is the only one carrying
 * inline controls, and the producer rebuilds that from the current selection.
 */
function sectionsForSelection(selectedId: string | null): ReadonlyArray<SelectionListOption> {
    return ['m-0', 'm-1', 'm-2'].map((id, index) => ({
        id,
        label: ['Alpha', 'Bravo', 'Charlie'][index],
        ...(id === selectedId
            ? { expandedContent: <Pressable testID={EXPANDED_TEST_ID} onPress={() => {}} /> }
            : {}),
    }));
}

describe('SelectionList — a declared columns config settles the pattern before layout', () => {
    it('opens a columned pane as a grid on the FIRST frame and never promotes it', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep(sectionsForSelection(null)),
                    columns: { max: 2, minColumnWidthPx: 250 },
                })}
            />,
        );

        // BEFORE any onLayout. The column count is still 1 here — that is the
        // frame the previous implementation shipped as a `listbox` and then
        // promoted, changing the container's role with the popup already open.
        expect(bodyRole(screen)).toBe('grid');
        expect(roleCensus(screen)).toEqual({ listbox: 0, option: 0, grid: 1, haspopup: 1 });

        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        expect(roleCensus(screen)).toEqual({ listbox: 0, option: 0, grid: 1, haspopup: 1 });
    });

    it('keeps the pattern across a resize over and back through the column threshold', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep(sectionsForSelection(null)),
                    columns: { max: 2, minColumnWidthPx: 250 },
                })}
            />,
        );

        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        expect(screen.findByTestId('sl:body')?.props['aria-colcount']).toBe(2);
        const wide = roleCensus(screen);

        // Down to one column — the pane genuinely reflows, and the COUNT
        // follows it. The pattern may not.
        await measureContainer(screen, ONE_COLUMN_WIDTH_PX);
        expect(screen.findByTestId('sl:body')?.props['aria-colcount']).toBe(1);
        expect(roleCensus(screen)).toEqual(wide);

        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        expect(roleCensus(screen)).toEqual(wide);
    });
});

describe('SelectionList — selection and filtering cannot move the pattern', () => {
    async function renderInlineControlsList(selectedId: string | null): Promise<{
        screen: Screen;
        selectTo: (nextSelectedId: string | null) => Promise<void>;
    }> {
        const { SelectionList } = await import('../SelectionList');
        const element = (nextSelectedId: string | null) => (
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep(sectionsForSelection(nextSelectedId)),
                    selectedOptionId: nextSelectedId,
                    optionsHostInlineControls: true,
                })}
            />
        );
        const screen = await renderScreen(element(selectedId));
        return {
            screen,
            // Re-renders the SAME mounted popup with the producer's rebuilt
            // sections, which is what actually happens on select.
            selectTo: (nextSelectedId) => screen.update(element(nextSelectedId)),
        };
    }

    it('holds the grid pattern when the rebuilt sections move the expanded option', async () => {
        const { screen, selectTo } = await renderInlineControlsList('m-1');
        expect(bodyRole(screen)).toBe('grid');
        const opened = roleCensus(screen);

        await selectTo('m-2');
        expect(roleCensus(screen)).toEqual(opened);

        // The case that refuted the previous attempt: the shipped consumer
        // withdraws the controls entirely for some selections (a provider
        // connection model has none), so the rebuilt sections carry NO
        // expandedContent at all. The declared capability is unchanged, so the
        // widget is unchanged.
        await selectTo(null);
        expect(screen.tree.root.findAll((node) => node.props?.testID === EXPANDED_TEST_ID))
            .toHaveLength(0);
        expect(roleCensus(screen)).toEqual(opened);

        await selectTo('m-0');
        expect(roleCensus(screen)).toEqual(opened);
    });

    it('holds the grid pattern while a query narrows the expanded option away', async () => {
        const { screen } = await renderInlineControlsList('m-1');
        const opened = roleCensus(screen);

        await act(async () => {
            screen.changeTextByTestId('sl:header:input', 'Alpha');
        });
        expect(screen.findByTestId('sl:root:option-wrapper:m-1')).toBeNull();
        expect(screen.findByTestId('sl:root:option-wrapper:m-0')).not.toBeNull();
        expect(roleCensus(screen)).toEqual(opened);

        await act(async () => {
            screen.changeTextByTestId('sl:header:input', '');
        });
        expect(roleCensus(screen)).toEqual(opened);
    });
});

describe('SelectionList — the grid describes the columns it actually paints', () => {
    it('gives a trailing partial row a real empty cell so every row fills aria-colcount', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep([
                        { id: 'm-0', label: 'Alpha' },
                        { id: 'm-1', label: 'Bravo' },
                        { id: 'm-2', label: 'Charlie' },
                    ]),
                    columns: { max: 2, minColumnWidthPx: 250 },
                })}
            />,
        );
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);

        const body = screen.findByTestId('sl:body');
        expect(body?.props['aria-colcount']).toBe(2);
        // The section header row plus the two painted option rows.
        expect(body?.props['aria-rowcount']).toBe(3);
        expect(bodyRows(screen).map((row) => row.props['aria-rowindex'])).toEqual([1, 2, 3]);

        // Three options at two columns: row 2 holds one card and one spacer.
        // The spacer is what keeps that card at column width instead of letting
        // it stretch across the pane, so it occupies a real column and must say
        // so — an empty cell, never an `aria-colspan` on its neighbour, because
        // the card visibly does not stretch.
        const rows = optionRows(screen);
        expect(rows).toHaveLength(2);
        const cellsPerRow = rows.map(
            (row) => row.findAll((node) => hasHostRole(node, 'gridcell')).length,
        );
        expect(cellsPerRow).toEqual([2, 2]);
        expect(
            rows.map((row) => row
                .findAll((node) => hasHostRole(node, 'gridcell'))
                .map((cell) => cell.props['aria-colindex'])),
        ).toEqual([[1, 2], [1, 2]]);
    });

    it('declares one column, and one cell per row, for a single-column grid', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep(sectionsForSelection('m-1')),
                    selectedOptionId: 'm-1',
                    optionsHostInlineControls: true,
                })}
            />,
        );

        const body = screen.findByTestId('sl:body');
        expect(body?.props.role).toBe('grid');
        // Stated, not left to be inferred. While it was omitted, assistive
        // technology read the widest row — the selected one, whose open panel
        // used to be a second cell — and announced "column 1 of 2" for every
        // row that had no second column.
        expect(body?.props['aria-colcount']).toBe(1);
        // The section header row plus one row per option.
        expect(body?.props['aria-rowcount']).toBe(4);
        expect(bodyRows(screen).map((row) => row.props['aria-rowindex'])).toEqual([1, 2, 3, 4]);

        const rows = optionRows(screen);
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => row.findAll((node) => hasHostRole(node, 'gridcell')).length))
            .toEqual([1, 1, 1]);

        // The selected row's expanded panel lives INSIDE that one cell, which is
        // also what the user sees: the controls open within the option, not in a
        // column beside it.
        const selectedCell = screen.findByTestId('sl:root:option-wrapper:m-1')
            ?.findAll((node) => hasHostRole(node, 'gridcell'))[0];
        expect(selectedCell?.props['aria-colindex']).toBe(1);
        expect(selectedCell?.findAll((node) => node.props?.testID === EXPANDED_TEST_ID))
            .toHaveLength(1);
    });
});

describe('SelectionList — identity guard for the single-column listbox', () => {
    /**
     * Byte-for-byte the markup every other consumer reads. If this block moves,
     * the change reached far past declared columns and declared row controls.
     */
    async function renderPlainList(props: Partial<SelectionListProps> = {}): Promise<Screen> {
        const { SelectionList } = await import('../SelectionList');
        return renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeStep([
                        { id: 'm-0', label: 'Alpha' },
                        { id: 'm-1', label: 'Bravo' },
                    ]),
                    ...props,
                })}
            />,
        );
    }

    function expectExactlyTheListboxSet(screen: Screen): void {
        const body = screen.findByTestId('sl:body');
        expect(body?.props.role).toBe('listbox');
        expect(body?.props['aria-rowcount']).toBeUndefined();
        expect(body?.props['aria-colcount']).toBeUndefined();
        expect(countRole(screen, 'grid')).toBe(0);
        expect(countRole(screen, 'row')).toBe(0);
        expect(countRole(screen, 'gridcell')).toBe(0);
        expect(screen.findByTestId('sl:header:input')?.props['aria-haspopup']).toBe('listbox');
    }

    it('emits exactly the listbox role set with neither capability declared', async () => {
        const screen = await renderPlainList();
        expectExactlyTheListboxSet(screen);

        const option = screen.findByTestId('sl:root:option:m-0');
        expect(option?.props.role).toBe('option');
        expect(option?.props['aria-posinset']).toBe(1);
        expect(option?.props['aria-setsize']).toBe(2);
        expect(screen.findByTestId('sl:root:option-wrapper:m-0')?.props.role).toBeUndefined();
        expect(screen.findByTestId('sl:root:option-wrapper:m-0')?.props['aria-colindex'])
            .toBeUndefined();
    });

    it('stays a listbox while the list is filtered', async () => {
        const screen = await renderPlainList();
        await act(async () => {
            screen.changeTextByTestId('sl:header:input', 'Alpha');
        });
        expectExactlyTheListboxSet(screen);
    });
});
