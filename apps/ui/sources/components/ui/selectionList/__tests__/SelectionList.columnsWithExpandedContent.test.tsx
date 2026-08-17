/**
 * The COMBINED configuration: a columned grid whose selected card expands.
 *
 * This is how the engine picker actually ships (`OptionPickerOverlay` sets both
 * `columns` and `expandedContent`), and until now the two features were only
 * ever tested apart — `SelectionList.columns.test.tsx` counts visual rows with
 * no inline controls anywhere, and `SelectionList.inlineControlsGridA11y.test.tsx`
 * pins the grid role set on a single-column list. Neither would notice the
 * combination collapsing.
 *
 * Two things are asserted here that neither of those files can reach:
 *
 *  1. **Structure.** The grid role set survives the column wrappers, and the
 *     expanded panel stays a cell of its OWN option's row — inside that option's
 *     column cell, never leaking across the gutter into its neighbour.
 *
 *  2. **Real keys against real geometry.** `useSelectionListKeyboardNav.columns.test.ts`
 *     injects a stub `resolveArrowTarget`, and the SelectionList suites never
 *     press a key, so the seam between the two — `buildSelectionListGridGeometry`
 *     producing NAV indices that `flatVisibleOptionIds` is then indexed by — is
 *     covered by neither. A disabled option is placed mid-grid on purpose: it
 *     renders (so it occupies a layout cell) but is absent from the nav array,
 *     which is precisely where a layout-index/nav-index mix-up becomes visible.
 *
 *  3. **The ARIA row model matches the visual one.** This is the defect the
 *     earlier revision of this file declined to pin: the columned grid reported
 *     one `role="row"` per OPTION with `aria-rowcount` counting options, so a
 *     screen-reader user was told there were five rows while three were
 *     painted, and no cell carried a column index at all. `aria-rowcount` /
 *     `aria-rowindex` now count VISUAL rows, `aria-colcount` / `aria-colindex`
 *     exist, and each row accounts for exactly the declared number of columns.
 *
 *     That last part is what decides where the expanded panel goes: it is part
 *     of its OPTION's cell, not a third cell in a two-column row. A cell whose
 *     column the grid never declared is exactly the incoherence being fixed,
 *     and the panel visibly expands inside its card rather than across the
 *     pane, so the cell is also the truthful reading.
 *
 * `SelectionList.inlineControlsGridA11y.test.tsx` pins the single-column grid,
 * whose markup is deliberately unchanged by all of this.
 */

import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListOption, SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { Pressable } from 'react-native';

const EXPANDED_TEST_ID = 'engine-inline-controls';

/** Wide enough for two 250px columns plus the shared 12px gutter. */
const TWO_COLUMN_WIDTH_PX = 546;

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function makeStep(options: ReadonlyArray<SelectionListOption>): SelectionListStep {
    return {
        id: 'root',
        title: 'Models',
        inputPlaceholder: 'Search models',
        sections: [{ kind: 'static', id: 'models', title: 'MODELS', options }],
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeStep([{ id: 'm-0', label: 'Model 0' }]),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        columns: { max: 2, minColumnWidthPx: 250 },
        ...overrides,
    };
}

/** The container's own measured width is the only signal the resolver reads. */
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

/**
 * Press a key through the SAME handler the search input receives, so the whole
 * orchestrator → geometry → keyboard-hook path runs. (On web the header binds
 * this to a real DOM `keydown` listener, which react-test-renderer has no node
 * for; the handler it binds is this one.)
 */
async function pressKey(screen: Screen, key: string): Promise<void> {
    const hosts = screen.tree.root.findAll(
        (node) => node.props?.testID === 'sl:header'
            && typeof node.props?.onKeyPress === 'function',
    );
    if (hosts.length !== 1) {
        throw new Error(`expected exactly one keyboard host, found ${hosts.length}`);
    }
    const onKeyPress = hosts[0].props.onKeyPress as (event: unknown) => void;
    await act(async () => {
        onKeyPress({
            key,
            preventDefault: () => {},
            stopPropagation: () => {},
            nativeEvent: { key },
        });
    });
}

/** The focused row, as the combobox reports it to assistive tech. */
function focusedOptionId(screen: Screen): unknown {
    return screen.findByTestId('sl:header:input')?.props['aria-activedescendant'];
}

/**
 * The visual flex rows the columns variant introduces, in order. Matched by
 * LAYOUT rather than by role, because the role is precisely what this file
 * asserts: `row` under the grid pattern, `presentation` under listbox.
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

function closestWithRole(node: ReactTestInstance, role: string): ReactTestInstance | null {
    let current: ReactTestInstance | null = node.parent;
    while (current) {
        if (current.props?.role === role) return current;
        current = current.parent;
    }
    return null;
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

const FOUR_MODELS = [
    { id: 'm-0', label: 'Model 0' },
    {
        id: 'm-1',
        label: 'Model 1',
        // Stand-in for the engine picker's per-option controls: interactive,
        // non-option markup that forces the grid pattern.
        expandedContent: <Pressable testID={EXPANDED_TEST_ID} onPress={() => {}} />,
    },
    { id: 'm-2', label: 'Model 2' },
    { id: 'm-3', label: 'Model 3' },
];

describe('SelectionList — columns and expandedContent together', () => {
    async function renderTwoColumnGrid(): Promise<Screen> {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({ rootStep: makeStep(FOUR_MODELS), selectedOptionId: 'm-1' })}
            />,
        );
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        return screen;
    }

    it('keeps the grid role set once the options are laid out in columns', async () => {
        const screen = await renderTwoColumnGrid();

        // The column wrappers must not knock the container back to a listbox —
        // a listbox owning the expanded controls is invalid markup.
        expect(screen.findByTestId('sl:body')?.props.role).toBe('grid');
        expect(screen.tree.root.findAll((node) => node.props?.role === 'listbox')).toHaveLength(0);
        expect(screen.tree.root.findAll((node) => node.props?.role === 'option')).toHaveLength(0);
        expect(screen.findByTestId('sl:header:input')?.props['aria-haspopup']).toBe('grid');

        // Every option is a cell inside a row inside the grid. The cell is the
        // option's own wrapper — the thing that holds the option AND whatever
        // else belongs to it — and the visual row above it owns the row role,
        // because that is the row the user sees.
        for (const id of ['m-0', 'm-1', 'm-2', 'm-3']) {
            const cell = screen.findByTestId(`sl:root:option-wrapper:${id}`);
            expect(cell?.props.role).toBe('gridcell');
            // The cell carries the identity `aria-activedescendant` points at.
            expect(cell?.props.id).toBe(`sl:root:option:${id}`);
            const row = closestWithRole(cell!, 'row');
            expect(row).not.toBeNull();
            expect(closestWithRole(row!, 'grid')).not.toBeNull();
            // …and the control inside it is a widget, never a nested cell.
            expect(screen.findByTestId(`sl:root:option:${id}`)?.props.role).toBe('button');
        }
    });

    it('numbers rows and columns by what is painted, not by option count', async () => {
        const screen = await renderTwoColumnGrid();

        // Four options in two columns are THREE things to a sighted user: a
        // header and two rows — and all three are rows of the grid, because the
        // header renders text and a grid may not own text outside a row.
        // Counting OPTIONS here (the defect) announced four rows and no columns
        // at all.
        const body = screen.findByTestId('sl:body');
        expect(body?.props['aria-rowcount']).toBe(3);
        expect(body?.props['aria-colcount']).toBe(2);

        const rows = columnRows(screen);
        expect(rows.map((row) => row.props.role)).toEqual(['row', 'row']);
        // Row 1 is the section header, so the option rows are 2 and 3.
        expect(rows.map((row) => row.props['aria-rowindex'])).toEqual([2, 3]);

        // Exactly `aria-colcount` cells per row, each with its own index — the
        // expanded panel included, since it belongs to m-1's cell.
        for (const row of rows) {
            const cells = row.findAll((node) => typeof node.type === 'string'
                && node.props?.role === 'gridcell');
            expect(cells.map((cell) => cell.props['aria-colindex'])).toEqual([1, 2]);
            // A full-width span is for short sections only; these rows are full.
            expect(cells.every((cell) => cell.props['aria-colspan'] === undefined)).toBe(true);
        }

        // Nothing keeps the option-level row markup the fix replaced.
        expect(screen.findByTestId('sl:root:option-wrapper:m-0')?.props['aria-rowindex'])
            .toBeUndefined();
    });

    it('groups the options into visual rows of two, row-major', async () => {
        const screen = await renderTwoColumnGrid();
        expect(optionIdsByColumnRow(screen, ['m-0', 'm-1', 'm-2', 'm-3'])).toEqual([
            ['m-0', 'm-1'],
            ['m-2', 'm-3'],
        ]);
    });

    it('keeps the expanded panel a cell of its own option, inside its own column', async () => {
        const screen = await renderTwoColumnGrid();
        const expanded = screen.findByTestId(EXPANDED_TEST_ID);
        expect(expanded).not.toBeNull();

        // Its own cell, and its own option's row — not loose in the row and not
        // smuggled inside the activatable cell (where it would be announced as
        // part of the option's own name).
        const cell = closestWithRole(expanded!, 'gridcell');
        expect(cell).not.toBeNull();
        expect(isDescendantOf(expanded!, screen.findByTestId('sl:root:option:m-1')!)).toBe(false);
        expect(isDescendantOf(expanded!, screen.findByTestId('sl:root:option-wrapper:m-1')!)).toBe(true);

        // Crucially for the grid: it expands INSIDE m-1's column cell rather
        // than spanning the pane, so the neighbouring card keeps its width.
        const [firstRow, secondRow] = columnRows(screen);
        expect(isDescendantOf(expanded!, firstRow)).toBe(true);
        expect(isDescendantOf(expanded!, secondRow)).toBe(false);
        expect(isDescendantOf(expanded!, screen.findByTestId('sl:root:option-wrapper:m-0')!)).toBe(false);
    });

    it('only builds the expanded panel for the selected option', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({ rootStep: makeStep(FOUR_MODELS), selectedOptionId: 'm-0' })}
            />,
        );
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        expect(screen.findAllByTestId(EXPANDED_TEST_ID)).toHaveLength(0);
        // …and the grid pattern still holds, because it is derived from the
        // whole plan rather than from whichever row happens to be open.
        expect(screen.findByTestId('sl:body')?.props.role).toBe('grid');
    });

    it('moves focus across the grid, including onto and off the expanded card', async () => {
        const screen = await renderTwoColumnGrid();
        // The selected card starts highlighted, but only IMPLICITLY: ←/→ still
        // belong to the text caret until the user focuses a row on purpose.
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-1');
        await pressKey(screen, 'ArrowLeft');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-1');

        // ↓ walks a whole visual row rather than a single option — and takes
        // explicit row focus, which is what hands ←/→ to the grid.
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');

        await pressKey(screen, 'ArrowLeft');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-2');

        // ↑ stays in its column across the row that hosts the expanded panel;
        // the extra height of that row must not shift which cell is "above".
        await pressKey(screen, 'ArrowUp');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-0');

        // → lands on the expanded card itself…
        await pressKey(screen, 'ArrowRight');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-1');

        // …and ↓ leaves it for the cell directly below, not the next option.
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');
    });
});

/**
 * The layout index space and the navigation index space diverge exactly when a
 * disabled option is rendered: it occupies a grid cell but is absent from
 * `flatVisibleOptionIds`. Every assertion below names an option that a
 * plausible off-by-one — geometry handing back a LAYOUT index, or the hook
 * falling back to linear movement — would get wrong.
 */
describe('SelectionList — real keys against the real grid geometry', () => {
    const MIXED = [
        { id: 'm-0', label: 'Model 0' },
        { id: 'm-1', label: 'Model 1' },
        { id: 'locked', label: 'Locked', disabled: true },
        { id: 'm-3', label: 'Model 3' },
        { id: 'm-4', label: 'Model 4' },
        { id: 'm-5', label: 'Model 5' },
    ];
    // Layout (2 columns, row-major)   nav array: [m-0, m-1, m-3, m-4, m-5]
    //   row 0:  m-0     m-1
    //   row 1:  locked  m-3
    //   row 2:  m-4     m-5

    async function renderMixedGrid(): Promise<Screen> {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ rootStep: makeStep(MIXED) })} />,
        );
        await measureContainer(screen, TWO_COLUMN_WIDTH_PX);
        return screen;
    }

    it('renders the disabled option as a real grid cell', async () => {
        const screen = await renderMixedGrid();
        expect(optionIdsByColumnRow(screen, ['m-0', 'm-1', 'locked', 'm-3', 'm-4', 'm-5'])).toEqual([
            ['m-0', 'm-1'],
            ['locked', 'm-3'],
            ['m-4', 'm-5'],
        ]);
    });

    it('steps over the disabled cell instead of landing on it or on its nav neighbour', async () => {
        const screen = await renderMixedGrid();
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-0');

        // ↓ from m-0 (row 0, column 0). The cell below is disabled, so the
        // nearest focusable in that row wins. A geometry returning the LAYOUT
        // index (3) would land on m-4; linear fallback would land on m-1.
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');

        // ↓ again. The detour into column 1 was forced by a disabled cell, not
        // chosen, so the roving column is still 0 and this lands on m-4. A grid
        // that forgets the desired column would drift to m-5 and leave the user
        // permanently one column over from where they started walking.
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-4');

        // ↓ off the last row wraps by ROW, still in the column being aimed at.
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-0');

        // → is an explicit re-aim: from here on column 1 is what ↓ preserves.
        await pressKey(screen, 'ArrowRight');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-1');
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-5');
    });

    it('clamps horizontal movement at the row edges and over a disabled cell', async () => {
        const screen = await renderMixedGrid();
        // Take explicit row focus first — an implicitly highlighted row leaves
        // ←/→ to the text caret.
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');

        // → at the right edge has nowhere to go and must not wrap into the next
        // visual row (that is ↓'s job, and it would steal the caret key).
        await pressKey(screen, 'ArrowRight');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');

        // ← would land on the disabled cell, so the key is released rather than
        // swallowed or used to skip into a different row.
        await pressKey(screen, 'ArrowLeft');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');
    });

    it('leaves a single-column list on the linear path even with the columns prop set', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ rootStep: makeStep(MIXED) })} />,
        );
        // Too narrow for two columns: the grid never engages.
        await measureContainer(screen, 420);
        expect(columnRows(screen)).toHaveLength(0);

        // Linear order over the NAV array — the disabled row is skipped, and
        // ↓ advances by one option rather than by a row of two.
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-1');
        await pressKey(screen, 'ArrowDown');
        expect(focusedOptionId(screen)).toBe('sl:root:option:m-3');
    });
});
