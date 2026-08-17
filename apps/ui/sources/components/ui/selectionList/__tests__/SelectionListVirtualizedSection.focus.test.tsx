import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SelectionListOption, SelectionListSection } from '../_types';

const reducedMotionState = vi.hoisted(() => ({ value: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.value,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Spy ref handle so we can assert that scrollToIndex is called when the
// keyboard-driven `focusedOptionId` changes to a row in this section.
const scrollToIndex = vi.fn<(args: { index: number; animated?: boolean; viewPosition?: number }) => void>();
const scrollToOffset = vi.fn();

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
    refHandle: { scrollToIndex, scrollToOffset },
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
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
 *   1. Mirror the focused-row visual state through `Item.focused` while
 *      keeping `Item.selected` reserved for the actual selection state.
 *   2. Imperatively scroll the focused row into view via
 *      `flashListRef.current.scrollToIndex({ index, viewPosition: 0.5,
 *      animated: true })` whenever `focusedOptionId` changes AND the focused
 *      row exists in this section.
 *   3. When `focusedOptionId` does NOT match any row in this section
 *      (e.g. focus is in a different section), do NOT call scrollToIndex.
 */
describe('SelectionListVirtualizedSection focus parity (F4)', () => {
    beforeEach(() => {
        reducedMotionState.value = false;
        scrollToIndex.mockClear();
    });
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

    it('marks the focused row visually focused without reporting it selected', async () => {
        legendListState.reset();
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
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        // Focus is visual state; selection remains the semantic row state
        // consumed by aria-selected.
        const focusedItem = findItemComposite(screen, 'sl:root:option:opt-25');
        expect(focusedItem).toBeTruthy();
        expect(focusedItem!.props.focused).toBe(true);
        expect(focusedItem!.props.selected).toBe(false);

        // A different unselected row has neither state.
        const otherItem = findItemComposite(screen, 'sl:root:option:opt-3');
        expect(otherItem).toBeTruthy();
        expect(otherItem!.props.focused).toBe(false);
        expect(otherItem!.props.selected).toBe(false);
    });

    it('still marks selected rows as selected when no focus is set', async () => {
        legendListState.reset();
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
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        const selectedItem = findItemComposite(screen, 'sl:root:option:opt-7');
        expect(selectedItem).toBeTruthy();
        expect(selectedItem!.props.selected).toBe(true);
    });

    it('calls scrollToIndex(viewPosition: 0.5) when focusedOptionId changes to a row in this section', async () => {
        legendListState.reset();
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
                onSelect={() => {}}
                onPushStep={() => {}}
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
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(scrollToIndex).toHaveBeenCalledTimes(1);
        const call = scrollToIndex.mock.calls[0][0];
        expect(call.index).toBe(30);
        expect(call.viewPosition).toBe(0.5);
        expect(call.animated).toBe(true);
    });

    it('scrolls focused rows without animation when reduced motion is enabled', async () => {
        reducedMotionState.value = true;
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');
        const section = makeSection(60);
        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                focusedOptionId={null}
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        await screen.update(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                focusedOptionId="opt-30"
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(scrollToIndex).toHaveBeenCalledWith({ index: 30, viewPosition: 0.5, animated: false });
    });

    it('does not call scrollToIndex when focusedOptionId does not match any row in this section', async () => {
        legendListState.reset();
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
                onSelect={() => {}}
                onPushStep={() => {}}
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
                onSelect={() => {}}
                onPushStep={() => {}}
            />,
        );

        expect(scrollToIndex).not.toHaveBeenCalled();
    });
});
