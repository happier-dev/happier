import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';

import type { SelectionListOption, SelectionListSection } from '../_types';

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

/**
 * RV-2 / F2 — Virtualized row activation must commit EXACTLY ONCE per press.
 * The section renders the canonical `PlanOptionRow`, whose press handler is the
 * single activation entry point (`activateSelectionListRow`): it invokes the
 * option-level `onSelect` and then bubbles to the orchestrator's `onSelect`.
 * A second activation wrapper around the section's own callback would produce a
 * double commit on directories with > 50 entries (auto-virtualized).
 */
describe('SelectionListVirtualizedSection activation contract (F2)', () => {
    it('activates a pressed row exactly once through the canonical activation entry point', async () => {
        legendListState.reset();
        const { SelectionListVirtualizedSection } = await import('../SelectionListVirtualizedSection');

        const optionOnSelect = vi.fn();
        const onSelect = vi.fn();
        const onPushStep = vi.fn();

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
                selectedOptionIds={new Set<string>()}
                onSelect={onSelect}
                onPushStep={onPushStep}
            />,
        );

        // Sanity: the virtualized backend mounted (forced).
        expect(legendListState.props).not.toBeNull();

        // The rendered Item carries the canonical option testID.
        const itemNode = screen.findByTestId('sl:root:option:row-0');
        expect(itemNode).not.toBeNull();
        expect(typeof itemNode!.props.onPress).toBe('function');

        itemNode!.props.onPress();

        expect(optionOnSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith('row-0', options[0]);
        expect(onPushStep).not.toHaveBeenCalled();
    });
});
