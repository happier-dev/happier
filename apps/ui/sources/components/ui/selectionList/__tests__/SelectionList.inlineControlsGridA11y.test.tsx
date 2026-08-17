/**
 * ARIA contract for rows that host their own interactive controls.
 *
 * A `listbox` may only own `option` (or `group` of options). The moment an
 * option carries `expandedContent` — a tab bar, switches, sliders — that
 * content is non-option interactive markup sitting inside the listbox, which
 * is invalid and makes screen readers mis-announce the whole list.
 *
 * The spec-sanctioned popup for a combobox whose rows contain several
 * interactive elements is the grid (WAI-ARIA APG, "combobox with grid popup"):
 * `role="grid"` → `role="row"` → `role="gridcell"`. These tests pin BOTH
 * modes: the default list must stay byte-for-byte a listbox, and a list that
 * DECLARES inline row controls must emit the grid pattern throughout.
 *
 * The capability is declared (`optionsHostInlineControls`), never sniffed from
 * the options: whether an option carries `expandedContent` right now depends on
 * the selection, and a pattern that tracks the selection flips while the popup
 * is open. `SelectionList.a11yPatternStability.test.tsx` owns that property;
 * this file owns the SHAPE the grid emits.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { Pressable } from 'react-native';

const EXPANDED_TEST_ID = 'inline-controls';

type TreeNode = Readonly<{ props?: Record<string, unknown>; parent?: unknown }>;

function makeStep(withInlineControls: boolean): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [{
            kind: 'static',
            id: 'section-a',
            title: 'SECTION A',
            options: [
                { id: 'opt-a', label: 'Alpha' },
                {
                    id: 'opt-b',
                    label: 'Bravo',
                    ...(withInlineControls
                        ? { expandedContent: <ExpandedControls /> }
                        : {}),
                },
            ],
        }],
    };
}

function ExpandedControls(): React.ReactElement {
    // Stand-in for the real per-option controls (a SegmentedTabBar + Switches):
    // interactive, non-option content that must not live inside a listbox.
    return <Pressable testID={EXPANDED_TEST_ID} onPress={() => {}} />;
}

function defaultProps(step: SelectionListStep, withInlineControls: boolean): SelectionListProps {
    return {
        rootStep: step,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        selectedOptionId: 'opt-b',
        testID: 'sl',
        ...(withInlineControls ? { optionsHostInlineControls: true } : {}),
    };
}

function ancestorWithRole(node: unknown, role: string): boolean {
    let current = (node as TreeNode | null)?.parent as TreeNode | undefined;
    while (current) {
        if (current.props?.role === role) return true;
        current = current.parent as TreeNode | undefined;
    }
    return false;
}

describe('SelectionList inline row controls require the grid ARIA pattern', () => {
    it('keeps the listbox role set exactly when no option carries expandedContent', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(makeStep(false), false)} />);

        const body = screen.findByTestId('sl:body');
        expect(body?.props.role).toBe('listbox');
        expect(body?.props['aria-rowcount']).toBeUndefined();

        const optA = screen.findByTestId('sl:root:option:opt-a');
        expect(optA?.props.role).toBe('option');
        expect(optA?.props['aria-posinset']).toBe(1);
        expect(optA?.props['aria-setsize']).toBe(2);
        expect(screen.findByTestId('sl:root:option-wrapper:opt-a')?.props.role).toBeUndefined();

        // Identity assertion: the default list must contain no grid markup at all.
        const gridish = screen.tree.root.findAll(
            (node) => node.props?.role === 'grid'
                || node.props?.role === 'row'
                || node.props?.role === 'gridcell',
        );
        expect(gridish).toHaveLength(0);

        expect(screen.findByTestId('sl:header:input')?.props['aria-haspopup']).toBe('listbox');
    });

    it('emits the whole grid role set when the caller declares inline row controls', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(makeStep(true), true)} />);

        // Container: grid, never listbox — a listbox owning a tab bar is invalid.
        const body = screen.findByTestId('sl:body');
        expect(body?.props.role).toBe('grid');
        expect(body?.props.id).toBe('sl:listbox');
        // The section header row plus one row per option: a header renders
        // text, and a grid may not own text outside a row.
        expect(body?.props['aria-rowcount']).toBe(3);
        expect(screen.findByTestId('sl:section:section-a:header')?.props.role)
            .toBe('columnheader');
        // A single-column grid STATES its one column. Omitting it let assistive
        // technology infer the count from the widest row, which was the selected
        // one back when its open panel was a second cell.
        expect(body?.props['aria-colcount']).toBe(1);
        expect(screen.tree.root.findAll((node) => node.props?.role === 'listbox')).toHaveLength(0);
        expect(screen.tree.root.findAll((node) => node.props?.role === 'option')).toHaveLength(0);

        // Rows: the layout wrapper becomes the row and owns the row index.
        const wrapperA = screen.findByTestId('sl:root:option-wrapper:opt-a');
        const wrapperB = screen.findByTestId('sl:root:option-wrapper:opt-b');
        expect(wrapperA?.props.role).toBe('row');
        expect(wrapperA?.props['aria-rowindex']).toBe(2);
        expect(wrapperB?.props.role).toBe('row');
        expect(wrapperB?.props['aria-rowindex']).toBe(3);

        // ONE OPTION IS ONE CELL. Every row holds exactly one, at column 1, and
        // that cell carries the identity `aria-activedescendant` points at plus
        // the option's selected state. The option used to be split across up to
        // three sibling cells (control, accessory, open panel), which left rows
        // ragged against a column count that was never declared.
        const cellsA = wrapperA?.findAll((node) => node.props?.role === 'gridcell') ?? [];
        const cellsB = wrapperB?.findAll((node) => node.props?.role === 'gridcell') ?? [];
        expect(cellsA).toHaveLength(1);
        expect(cellsB).toHaveLength(1);
        expect(cellsB[0]?.props.id).toBe('sl:root:option:opt-b');
        expect(cellsB[0]?.props['aria-colindex']).toBe(1);
        expect(cellsB[0]?.props['aria-selected']).toBe(true);
        expect(cellsA[0]?.props['aria-selected']).toBe(false);

        // The activatable control inside the cell is a WIDGET, not a second
        // cell: a gridcell within a gridcell is invalid, and the id would be a
        // duplicate.
        const optB = screen.findByTestId('sl:root:option:opt-b');
        expect(optB?.props.role).toBe('button');
        expect(optB?.props.id).toBeUndefined();
        expect(optB?.props['aria-posinset']).toBeUndefined();
        expect(optB?.props['aria-setsize']).toBeUndefined();

        // The expanded panel is inside the option's own cell — the same shape a
        // multi-column card uses, and the same shape the user sees: the controls
        // open within the option rather than in a column beside it.
        const expanded = screen.findByTestId(EXPANDED_TEST_ID);
        expect(expanded).not.toBeNull();
        expect(cellsB[0]?.findAll((node) => node.props?.testID === EXPANDED_TEST_ID))
            .toHaveLength(1);
        expect(ancestorWithRole(expanded, 'row')).toBe(true);
        // …and never inside the activatable control itself: nesting it there
        // would make every switch flip and segment tap re-commit the selection.
        for (const rowNode of screen.findAllByTestId('sl:root:option:opt-b')) {
            let current = (expanded as TreeNode | null)?.parent as TreeNode | undefined;
            let nested = false;
            while (current) {
                if (current === (rowNode as unknown as TreeNode)) nested = true;
                current = current.parent as TreeNode | undefined;
            }
            expect(nested).toBe(false);
        }

        // A single-column grid declares no column BEYOND its one: the row keeps
        // no column metadata of its own, and nothing claims a colspan.
        expect(wrapperA?.props['aria-colindex']).toBeUndefined();
        expect(wrapperA?.props.id).toBeUndefined();
        for (const node of screen.tree.root.findAll(
            (candidate) => candidate.props?.['aria-colspan'] !== undefined,
        )) {
            throw new Error(`unexpected colspan on ${String(node.props?.testID)}`);
        }

        // The combobox must advertise the popup role it actually renders.
        const input = screen.findByTestId('sl:header:input');
        expect(input?.props['aria-haspopup']).toBe('grid');
        expect(input?.props['aria-controls']).toBe('sl:listbox');
    });
});
