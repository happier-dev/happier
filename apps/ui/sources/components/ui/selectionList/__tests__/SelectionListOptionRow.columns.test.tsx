/**
 * Lane G4 — `PlanSuccessRows` row identity and column count.
 *
 * `PlanSuccessRows` uses no hooks, so it can be invoked as a plain function and
 * its returned element tree read directly: that is the only place a block's
 * React key is observable. The rendered layout itself — no column wrapper at
 * one column, independent column stacks, disabled options kept as cells — is
 * proven through the public SelectionList by
 * `SelectionList.columns.test.tsx`, `SelectionListCardRowGap.test.tsx`,
 * `SelectionList.columnsWithExpandedContent.test.tsx` and
 * `SelectionList.a11yPatternStability.test.tsx`.
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PlanSuccessRows, type RenderPlanRowsProps } from '../SelectionListOptionRow';
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
        selectedOptionIds: new Set<string>(),
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

describe('PlanSuccessRows — multi-column layout', () => {
    it('keys each block by its leading option so blocks keep identity', () => {
        // Read the raw children array: `React.Children.toArray` rewrites keys
        // with its own prefix, which would hide the key we actually assign.
        const blocks = (PlanSuccessRows(makeProps({ plan: makePlan(120), columnCount: 2 }))
            .props as { children: React.ReactElement[] }).children;
        expect(blocks.map((block) => block.key)).toEqual([
            'column-row:opt-0',
            'column-row:opt-50',
            'column-row:opt-100',
        ]);
    });

    it('stacks a short list as one block of independent columns, carrying the resolved column count', () => {
        // Columns stack on their own (as 0.2): an open card never reserves height beside its neighbour.
        const blocks = childrenOf(PlanSuccessRows(makeProps({ plan: makePlan(7), columnCount: 3 })));
        expect(blocks).toHaveLength(1);
        expect((blocks[0]!.props as { children: React.ReactElement[] }).children).toHaveLength(7);
        expect((blocks[0]!.props as { columnCount: number }).columnCount).toBe(3);
    });
});
