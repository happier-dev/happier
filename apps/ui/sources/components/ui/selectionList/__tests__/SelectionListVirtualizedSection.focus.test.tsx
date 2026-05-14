import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingFlashListMock } from '@/dev/testkit/mocks/flashList';

import type { SelectionListOption, SelectionListSection } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Spy ref handle so we can assert that scrollToIndex is called when the
// keyboard-driven `focusedOptionId` changes to a row in this section.
const scrollToIndex = vi.fn<(args: { index: number; animated?: boolean; viewPosition?: number }) => void>();
const scrollToOffset = vi.fn();

const { module: capturedFlashList, state: flashListState } = createCapturingFlashListMock({
    componentName: 'FlashListMock',
    itemWrapperName: 'FlashListItemMock',
    renderItems: true,
    refHandle: { scrollToIndex, scrollToOffset },
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: capturedFlashList.FlashList,
    flashListRuntime: { usingFallback: true },
}));

function makeOptions(count: number, prefix = 'opt'): ReadonlyArray<SelectionListOption> {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `Option ${i}`,
    }));
}

function makeSection(count: number): SelectionListSection {
    return {
        id: 'big-section',
        title: 'BIG',
        options: makeOptions(count),
    };
}

/**
 * RV-2 / F4 — Virtualized rows must achieve focus parity with the
 * non-virtualized path:
 *   1. Mirror the focused-row visual state by selecting the focused option's
 *      `Item.selected` prop (matches `PlanOptionRow`'s
 *      `selected={isSelected || isFocused}` rule in SelectionListBody).
 *   2. Imperatively scroll the focused row into view via
 *      `flashListRef.current.scrollToIndex({ index, viewPosition: 0.5,
 *      animated: true })` whenever `focusedOptionId` changes AND the focused
 *      row exists in this section.
 *   3. When `focusedOptionId` does NOT match any row in this section
 *      (e.g. focus is in a different section), do NOT call scrollToIndex.
 */
describe('SelectionListVirtualizedSection focus parity (F4)', () => {
    /**
     * Resolve the Item composite instance that owns `selected` (vs the host
     * Pressable that `findByTestId` returns by preference). React Test
     * Renderer surfaces the Item React component by function type for the
     * same testID, so we filter to the composite (`typeof type === 'function'`).
     */
    function findItemComposite(screen: { findAllByTestId: (id: string) => Array<{ type: unknown; props: Record<string, unknown> }> }, testID: string) {
        const all = screen.findAllByTestId(testID);
        return all.find((node) => typeof node.type === 'function');
    }

    it('marks the focused row as visually selected via Item.selected (focus parity with non-virtualized rows)', async () => {
        flashListState.props = null;
        scrollToIndex.mockClear();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const section = makeSection(60);
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                focusedOptionId="opt-25"
                onSelectOption={() => {}}
            />,
        );

        // Focused row: Item.selected must be true so the row paints the
        // focused/selected styling (the Item primitive treats selected as
        // its visual focused state via showSelectedBackground).
        const focusedItem = findItemComposite(screen, 'sl:root:option:opt-25');
        expect(focusedItem).toBeTruthy();
        expect(focusedItem!.props.selected).toBe(true);

        // Non-focused row: Item.selected must be false.
        const otherItem = findItemComposite(screen, 'sl:root:option:opt-3');
        expect(otherItem).toBeTruthy();
        expect(otherItem!.props.selected).toBe(false);
    });

    it('still marks selected rows as selected when no focus is set', async () => {
        flashListState.props = null;
        scrollToIndex.mockClear();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const section = makeSection(60);
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId="opt-7"
                focusedOptionId={null}
                onSelectOption={() => {}}
            />,
        );

        const selectedItem = findItemComposite(screen, 'sl:root:option:opt-7');
        expect(selectedItem).toBeTruthy();
        expect(selectedItem!.props.selected).toBe(true);
    });

    it('calls scrollToIndex(viewPosition: 0.5) when focusedOptionId changes to a row in this section', async () => {
        flashListState.props = null;
        scrollToIndex.mockClear();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const section = makeSection(60);
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                focusedOptionId={null}
                onSelectOption={() => {}}
            />,
        );

        // Initial render with no focus: no scroll.
        expect(scrollToIndex).not.toHaveBeenCalled();

        // Now update with focus on opt-30.
        await screen.update(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                focusedOptionId="opt-30"
                onSelectOption={() => {}}
            />,
        );

        expect(scrollToIndex).toHaveBeenCalledTimes(1);
        const call = scrollToIndex.mock.calls[0][0];
        expect(call.index).toBe(30);
        expect(call.viewPosition).toBe(0.5);
        expect(call.animated).toBe(true);
    });

    it('does not call scrollToIndex when focusedOptionId does not match any row in this section', async () => {
        flashListState.props = null;
        scrollToIndex.mockClear();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const section = makeSection(60);
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                focusedOptionId={null}
                onSelectOption={() => {}}
            />,
        );

        await screen.update(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                // Focus belongs to a different section's option id.
                focusedOptionId="favorite:/Users/me/elsewhere"
                onSelectOption={() => {}}
            />,
        );

        expect(scrollToIndex).not.toHaveBeenCalled();
    });
});
