import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SectionRenderPlan } from '../SelectionListRenderPlan';
import type { SelectionListOption, SelectionListStep } from '../_types';

const reducedMotionState = vi.hoisted(() => ({ value: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.value,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Spy ref handle so we can assert that the body's flat-FlashList path calls
// scrollToIndex with the flattened index when the focused option lives in
// the SECOND virtualized section.
const scrollToIndex = vi.fn<(args: { index: number; animated?: boolean; viewPosition?: number }) => void>();
const scrollToOffset = vi.fn();

const { module: capturedLegendList } = createCapturingLegendListMock({
    renderItems: true,
    refHandle: { scrollToIndex, scrollToOffset },
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

function makeOptions(count: number, prefix: string): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Label ${prefix}-${i}`,
    }));
}

function buildMultiSectionPlan(): ReadonlyArray<SectionRenderPlan> {
    return [
        {
            id: 'first',
            title: 'FIRST',
            options: makeOptions(60, 'first'),
            virtualization: 'force',
        },
        {
            id: 'second',
            title: 'SECOND',
            options: makeOptions(60, 'second'),
            virtualization: 'force',
        },
    ];
}

function buildMixedSectionPlan(): ReadonlyArray<SectionRenderPlan> {
    return [
        {
            id: 'native',
            title: 'NATIVE',
            options: makeOptions(7, 'native'),
        },
        {
            id: 'provider',
            title: 'PROVIDER',
            options: makeOptions(60, 'provider'),
            virtualization: 'force',
        },
        {
            id: 'other',
            title: 'OTHER',
            options: makeOptions(1, 'other'),
        },
    ];
}

function buildBodyStep(): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [],
    };
}

/**
 * RV-9 / FRESH-3 — Focus-driven scroll on the flat-FlashList multi-section
 * body path. When the keyboard focus lands on an option that lives in the
 * SECOND (or any subsequent) virtualized section, the body must call
 * FlashList.scrollToIndex with the FLATTENED index (including section-
 * header offsets) so the focused row is centered in the viewport.
 */
describe('SelectionListBody flat virtualized-list focused-row scroll (RV-9)', () => {
    beforeEach(() => {
        reducedMotionState.value = false;
        scrollToIndex.mockClear();
        scrollToOffset.mockClear();
    });

    it('does not call scrollToIndex when focusedOptionId is null on initial render', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMultiSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(scrollToIndex).not.toHaveBeenCalled();
    });

    it('calls scrollToIndex with the flattened index when focused option is in the SECOND virtualized section', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMultiSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        await screen.update(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMultiSectionPlan()}
                focusedOptionId="second-4"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        // Expected flattened index: 1 (first header) + 60 (first rows)
        //   + 1 (second header) + 4 (second-0..second-4) = 66.
        expect(scrollToIndex).toHaveBeenCalled();
        const call = scrollToIndex.mock.calls.at(-1)?.[0];
        expect(call?.index).toBe(66);
        expect(call?.viewPosition).toBe(0.5);
        expect(call?.animated).toBe(true);
    });

    it('uses the body owner and flattened index when one eligible section has plain neighbors', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMixedSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        await screen.update(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMixedSectionPlan()}
                focusedOptionId="provider-10"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        // [native header, 7 native rows, provider header, provider-0..10]
        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 19,
            viewPosition: 0.5,
            animated: true,
        });
    });

    it('scrolls the flat recycler without animation when reduced motion is enabled', async () => {
        reducedMotionState.value = true;
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMultiSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        await screen.update(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMultiSectionPlan()}
                focusedOptionId="second-4"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(scrollToIndex).toHaveBeenCalledWith({ index: 66, viewPosition: 0.5, animated: false });
    });

    it('does not call scrollToIndex when the focused option does not match any row in the plan (e.g. focus moved out)', async () => {
        const { SelectionListBody } = await import('../SelectionListBody');
        const screen = await renderScreen(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMultiSectionPlan()}
                focusedOptionId={null}
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        await screen.update(
            <SelectionListBody
                step={buildBodyStep()}
                rootTestID="sl"
                selectedOptionId={null}
                plan={buildMultiSectionPlan()}
                focusedOptionId="not-in-any-section"
                listboxId="listbox"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );
        expect(scrollToIndex).not.toHaveBeenCalled();
    });
});
