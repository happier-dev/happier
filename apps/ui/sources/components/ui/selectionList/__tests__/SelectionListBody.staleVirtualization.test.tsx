import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingFlashListMock } from '@/dev/testkit/mocks/flashList';

import type { SectionRenderPlan } from '../SelectionListRenderPlan';
import type {
    SelectionListOption,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedFlashList, state: flashListState } = createCapturingFlashListMock({
    componentName: 'FlashListMock',
    itemWrapperName: 'FlashListItemMock',
    renderItems: true,
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: capturedFlashList.FlashList,
    flashListRuntime: { usingFallback: true },
}));

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
    flashListState.props = null;
});

afterEach(() => {
    flashListState.props = null;
});

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
 * the FlashList path (single virtualized section path OR flat-FlashList
 * path when multiple are eligible).
 *
 * These tests pin the contract by passing a hand-built `plan` directly to
 * `SelectionListBody`, isolating the body's virtualization-eligibility
 * decision from the live dynamic-section hook.
 */
describe('SelectionListBody stale dynamic virtualization (FR4-3)', () => {
    it('routes a 60-row dynamic section in success state through FlashList (baseline)', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const plan: ReadonlyArray<SectionRenderPlan> = [
            {
                id: 'big',
                title: 'BIG',
                options: makeOptions(60, 'opt'),
                virtualization: 'force',
            },
        ];
        await renderScreen(
            <SelectionListBody
                step={STEP}
                rootTestID="sl"
                selectedOptionId={null}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(flashListState.props).not.toBeNull();
    });

    it('keeps the FlashList path active when the same section is in dynamicState=loading with stale options', async () => {
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
        await renderScreen(
            <SelectionListBody
                step={STEP}
                rootTestID="sl"
                selectedOptionId={null}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // FR4-3 contract: the body MUST still mount a FlashList for the stale
        // option-bearing dynamic section. Pre-fix this falls through to a
        // plain mapped ScrollView (no FlashList captured).
        expect(flashListState.props).not.toBeNull();
    });

    it('keeps the FlashList path active when the section is in dynamicState=error with stale options', async () => {
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
        await renderScreen(
            <SelectionListBody
                step={STEP}
                rootTestID="sl"
                selectedOptionId={null}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // FR4-3 contract: errors with stale rows MUST stay virtualized too.
        expect(flashListState.props).not.toBeNull();
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
                selectedOptionId={null}
                plan={plan}
                focusedOptionId={null}
                listboxId="sl:listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // No options to virtualize → FlashList must NOT be mounted (skeleton
        // rows render as plain Views).
        expect(flashListState.props).toBeNull();
    });
});
