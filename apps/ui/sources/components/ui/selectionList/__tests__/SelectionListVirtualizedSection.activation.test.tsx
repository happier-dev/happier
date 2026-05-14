import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingFlashListMock } from '@/dev/testkit/mocks/flashList';

import type { SelectionListOption, SelectionListSection } from '../_types';

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

/**
 * RV-2 / F2 — Virtualized row activation must call `option.onSelect` EXACTLY
 * ONCE per press. Previously the inner row press handler called both
 * `option.onSelect?.()` AND `props.onSelectOption(option)`; the orchestrator's
 * `handleVirtualizedSelect` then routed through `activateSelectionListRow`,
 * which calls `option.onSelect?.()` again — producing a double commit on
 * directories with > 50 entries (auto-virtualized).
 *
 * The fix removes the inner call; the orchestrator's
 * `activateSelectionListRow` is the single source of truth (already proven by
 * the non-virtualized `PlanOptionRow` path).
 */
describe('SelectionListVirtualizedSection activation contract (F2)', () => {
    it('invokes the row press handler exactly once and bubbles the option to onSelectOption (no inner option.onSelect)', async () => {
        flashListState.props = null;
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const optionOnSelect = vi.fn();
        const onSelectOption = vi.fn();

        const options: ReadonlyArray<SelectionListOption> = [
            {
                id: 'row-0',
                label: 'Row 0',
                onSelect: optionOnSelect,
            },
        ];
        const section: SelectionListSection = {
            id: 'forced',
            title: 'FORCED',
            options,
        };

        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelectOption={onSelectOption}
                virtualization="force"
            />,
        );

        // Sanity: FlashList mounted (forced).
        expect(flashListState.props).not.toBeNull();

        // The rendered Item carries the canonical option testID.
        const itemNode = screen.findByTestId('sl:root:option:row-0');
        expect(itemNode).not.toBeNull();
        expect(typeof itemNode!.props.onPress).toBe('function');

        // Press the row. The inner handler MUST NOT call option.onSelect
        // — the orchestrator owns activation via onSelectOption.
        itemNode!.props.onPress();

        // Inner handler did NOT directly invoke option.onSelect.
        expect(optionOnSelect).not.toHaveBeenCalled();
        // The orchestrator wrapper received exactly one call with the option.
        expect(onSelectOption).toHaveBeenCalledTimes(1);
        expect(onSelectOption).toHaveBeenCalledWith(options[0]);
    });

    it('does not call onSelectOption when the option is disabled', async () => {
        flashListState.props = null;
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const optionOnSelect = vi.fn();
        const onSelectOption = vi.fn();

        const section: SelectionListSection = {
            id: 'forced',
            title: 'FORCED',
            options: [
                {
                    id: 'row-d',
                    label: 'Disabled',
                    disabled: true,
                    onSelect: optionOnSelect,
                },
            ],
        };

        const screen = await renderScreen(
            <SelectionListVirtualizedSection
                section={section}
                stepId="root"
                rootTestID="sl"
                selectedOptionId={null}
                onSelectOption={onSelectOption}
                virtualization="force"
            />,
        );

        const itemNode = screen.findByTestId('sl:root:option:row-d');
        expect(itemNode).not.toBeNull();
        itemNode!.props.onPress();

        expect(optionOnSelect).not.toHaveBeenCalled();
        expect(onSelectOption).not.toHaveBeenCalled();
    });
});
