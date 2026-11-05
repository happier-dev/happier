import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SectionRenderPlan } from '../SelectionListRenderPlan';
import type {
    SelectionListOption,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
});

vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    LegendList: capturedLegendList.LegendList,
}));

// Loaded after the mocks: a static import would evaluate the row graph before
// the hoisted LegendList factory can read `capturedLegendList`.
const { SELECTION_LIST_STALE_OPTIONS_OPACITY } = await import('../SelectionListDynamicSectionRows');

function makeOptions(count: number, prefix: string): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Label ${prefix}-${i}`,
    }));
}

const STEP: SelectionListStep = {
    id: 'root',
    inputPlaceholder: 'Search',
    sections: [],
};

beforeEach(() => {
    legendListState.reset();
});

type TreeNode = Readonly<{ props?: Readonly<Record<string, unknown>>; parent?: TreeNode | null }>;

function flattenStyle(style: unknown): Readonly<Record<string, unknown>> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style !== null && typeof style === 'object' ? style as Record<string, unknown> : {};
}

/** Whether any ancestor of the row paints the stale-section dimming. */
function isDimmedAsStale(node: unknown): boolean {
    for (let current = node as TreeNode | null | undefined; current; current = current.parent) {
        if (flattenStyle(current.props?.style).opacity === SELECTION_LIST_STALE_OPTIONS_OPACITY) return true;
    }
    return false;
}

/**
 * FR4-3 — Stale dynamic sections must keep virtualizing.
 *
 * Background: `collectVirtualizationEligibleSectionIds` previously skipped
 * every section with `dynamicState !== undefined`. A 60-row dynamic section
 * that virtualized in success state would fall back to a plain mapped
 * ScrollView during refetch (loading-with-stale) or transient error.
 *
 * Fix: include stale option-bearing `loading` / `error` sections in the
 * virtualization eligibility predicate so they continue rendering through
 * the virtualized path.
 *
 * These tests pin the contract by passing a hand-built `plan` directly to
 * `SelectionListBody`, isolating the body's virtualization-eligibility
 * decision from the live dynamic-section hook.
 */
describe('SelectionListBody stale dynamic virtualization (FR4-3)', () => {
    it('keeps the virtualized path active when the same section is in dynamicState=loading with stale options', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const plan: ReadonlyArray<SectionRenderPlan> = [
            {
                id: 'big',
                title: 'BIG',
                // Stale-while-revalidate: the resolver is loading, but the
                // last successful options are still surfaced for interaction.
                options: makeOptions(60, 'opt'),
                virtualization: 'force',
                dynamicState: 'loading',
                isStale: true,
                skeletonRowCount: 0,
            },
        ];
        const screen = await renderScreen(
            <SelectionListBody
                step={STEP}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // FR4-3 contract: the body MUST still mount a virtualized list for the stale
        // option-bearing dynamic section. Pre-fix this falls through to a
        // plain mapped ScrollView (no virtualized list captured).
        expect(legendListState.props).not.toBeNull();
        // While the same rows are refreshed they keep their ink: last-known results never read as disabled
        // (the section's loading line says it is still looking).
        const refreshingRow = screen.findByTestId('sl:root:option-wrapper:opt-0');
        expect(refreshingRow).not.toBeNull();
        expect(isDimmedAsStale(refreshingRow)).toBe(false);
    });

    it('keeps the virtualized path active when the section is in dynamicState=error with stale options', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const plan: ReadonlyArray<SectionRenderPlan> = [
            {
                id: 'big',
                title: 'BIG',
                options: makeOptions(60, 'opt'),
                virtualization: 'force',
                dynamicState: 'error',
                isStale: true,
                hint: 'Network glitch',
            },
        ];
        const screen = await renderScreen(
            <SelectionListBody
                step={STEP}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // FR4-3 contract: errors with stale rows MUST stay virtualized too.
        expect(legendListState.props).not.toBeNull();
        // Rows retained through a failure read as stale (the control for the
        // refreshing case above, which must not dim).
        expect(isDimmedAsStale(screen.findByTestId('sl:root:option-wrapper:opt-0'))).toBe(true);
    });

    it('still excludes pure skeleton loading (no stale options) from virtualization eligibility', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const plan: ReadonlyArray<SectionRenderPlan> = [
            {
                id: 'big',
                title: 'BIG',
                options: [], // no stale
                virtualization: 'force',
                dynamicState: 'loading',
                isStale: false,
                skeletonRowCount: 3,
            },
        ];
        await renderScreen(
            <SelectionListBody
                step={STEP}
                rootTestID="sl"
                selectedOptionIds={new Set<string>()}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // No options to virtualize → the virtualized list must NOT be mounted (skeleton
        // rows render as plain Views).
        expect(legendListState.props).toBeNull();
    });
});
