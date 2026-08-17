/**
 * Lane G4 — `PlanSuccessRows` cell layout.
 *
 * `PlanSuccessRows` uses no hooks, so it can be invoked as a plain function
 * and its returned element tree compared structurally. That is what lets the
 * single-column IDENTITY claim be an assertion rather than a promise: the
 * columns variant must not create a second rendering path for the layout
 * every existing consumer (and all of mobile) still uses.
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PlanSuccessRows, type RenderPlanRowsProps } from '../SelectionListOptionRow';
import { SelectionListColumnRow } from '../SelectionListColumnRow';
import type { SectionRenderPlan } from '../SelectionListRenderPlan';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const onSelect = vi.fn();
const onPushStep = vi.fn();

function makePlan(count: number): SectionRenderPlan {
    return {
        id: 'models',
        options: Array.from({ length: count }, (_, index) => ({
            id: `opt-${index}`,
            label: `Option ${index}`,
        })),
    };
}

function makeProps(overrides: Partial<RenderPlanRowsProps> = {}): RenderPlanRowsProps {
    return {
        plan: makePlan(5),
        rootTestID: 'sl',
        stepId: 'root',
        selectedOptionId: null,
        focusedOptionId: null,
        onSelect,
        onPushStep,
        ...overrides,
    };
}

function childrenOf(element: React.ReactElement): React.ReactElement[] {
    const { children } = element.props as { children?: React.ReactNode };
    return React.Children.toArray(children) as React.ReactElement[];
}

describe('PlanSuccessRows — single column is the untouched path', () => {
    it('returns an identical tree whether columnCount is 1 or omitted entirely', () => {
        const props = makeProps();
        expect(PlanSuccessRows({ ...props, columnCount: 1 }))
            .toEqual(PlanSuccessRows(props));
    });

    it('returns an identical tree for columnCount 0 and negative values', () => {
        const props = makeProps();
        const baseline = PlanSuccessRows(props);
        expect(PlanSuccessRows({ ...props, columnCount: 0 })).toEqual(baseline);
        expect(PlanSuccessRows({ ...props, columnCount: -2 })).toEqual(baseline);
    });

    it('wraps nothing around the rows at a single column', () => {
        const rows = childrenOf(PlanSuccessRows(makeProps()));
        expect(rows).toHaveLength(5);
        for (const row of rows) {
            expect(row.type).not.toBe(SelectionListColumnRow);
        }
    });
});

describe('PlanSuccessRows — multi-column layout', () => {
    it('groups options into visual rows of columnCount cells, row-major', () => {
        const visualRows = childrenOf(PlanSuccessRows(makeProps({ columnCount: 2 })));
        expect(visualRows).toHaveLength(3);
        for (const visualRow of visualRows) {
            expect(visualRow.type).toBe(SelectionListColumnRow);
        }
        const cellIdsPerRow = visualRows.map((visualRow) => (
            (visualRow.props as { children: React.ReactElement[] }).children.map(
                (cell) => (cell.props as { option: { id: string } }).option.id,
            )
        ));
        // Row-major: 0 1 | 2 3 | 4. A column-major fill would produce 0 3 | 1 4 | 2.
        expect(cellIdsPerRow).toEqual([
            ['opt-0', 'opt-1'],
            ['opt-2', 'opt-3'],
            ['opt-4'],
        ]);
    });

    it('keys each visual row by its leading option so rows keep identity', () => {
        // Read the raw children array: `React.Children.toArray` rewrites keys
        // with its own prefix, which would hide the key we actually assign.
        const visualRows = (PlanSuccessRows(makeProps({ columnCount: 2 }))
            .props as { children: React.ReactElement[] }).children;
        expect(visualRows.map((visualRow) => visualRow.key)).toEqual([
            'column-row:opt-0',
            'column-row:opt-2',
            'column-row:opt-4',
        ]);
    });

    it('keeps disabled options as cells rather than dropping them from the grid', () => {
        const plan: SectionRenderPlan = {
            id: 'models',
            options: [
                { id: 'a', label: 'A' },
                { id: 'locked', label: 'Locked', disabled: true },
                { id: 'c', label: 'C' },
            ],
        };
        const visualRows = childrenOf(PlanSuccessRows(makeProps({ plan, columnCount: 2 })));
        const renderedIds = visualRows.flatMap((visualRow) => (
            (visualRow.props as { children: React.ReactElement[] }).children.map(
                (cell) => (cell.props as { option: { id: string } }).option.id,
            )
        ));
        expect(renderedIds).toEqual(['a', 'locked', 'c']);
    });

    it('carries three columns through when the layout resolved three', () => {
        const visualRows = childrenOf(PlanSuccessRows(makeProps({ plan: makePlan(7), columnCount: 3 })));
        expect(visualRows).toHaveLength(3);
        expect(visualRows.map((visualRow) => (
            (visualRow.props as { children: React.ReactElement[] }).children.length
        ))).toEqual([3, 3, 1]);
        for (const visualRow of visualRows) {
            expect((visualRow.props as { columnCount: number }).columnCount).toBe(3);
        }
    });
});
