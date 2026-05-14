import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingFlashListMock } from '@/dev/testkit/mocks/flashList';

import type { SectionRenderPlan } from '../SelectionListRenderPlan';
import type { SelectionListOption, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Spy ref handle so we can assert that the body's flat-FlashList path calls
// scrollToIndex with the flattened index when the focused option lives in
// the SECOND virtualized section.
const scrollToIndex = vi.fn<(args: { index: number; animated?: boolean; viewPosition?: number }) => void>();
const scrollToOffset = vi.fn();

const { module: capturedFlashList } = createCapturingFlashListMock({
    componentName: 'FlashListMock',
    itemWrapperName: 'FlashListItemMock',
    renderItems: true,
    refHandle: { scrollToIndex, scrollToOffset },
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
describe('SelectionListBody flat-FlashList focused-row scroll (RV-9)', () => {
    beforeEach(() => {
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
