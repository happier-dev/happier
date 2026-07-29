import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import type { AgentInputChipPickerOption } from './AgentInputChipPickerTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks();

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props, null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: { children?: React.ReactNode }) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: (props: { children?: React.ReactNode }) => React.createElement('ItemListStatic', props, props.children),
}));

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('AgentInputChipPickerDetailPane', () => {
    it('defers opted-in detail content until after interactions before reusing rendered detail', async () => {
        vi.useFakeTimers();

        const renderDetailContent = vi.fn(() => React.createElement('View', { testID: 'detail:heavy-model-picker' }));
        const onRequestClose = vi.fn();
        const deferredOption: AgentInputChipPickerOption = {
            id: 'engine:claude',
            label: 'Claude',
            deferRenderDetailContent: true,
            deferredDetailContentCacheKey: 'test-engine-claude',
            renderDetailContent,
        };

        const { AgentInputChipPickerDetailPane } = await import('./AgentInputChipPickerDetailPane');
        const screen = await renderScreen(
            <AgentInputChipPickerDetailPane
                option={deferredOption}
                onApply={() => {}}
                applyLabel="Use"
                onSelectDetailOption={() => {}}
                onRequestClose={onRequestClose}
            />,
        );

        expect(renderDetailContent).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-chip-picker.detail-deferred-placeholder')).toBeTruthy();
        expect(screen.findByTestId('detail:heavy-model-picker')).toBeNull();

        await act(async () => {
            vi.runAllTimers();
        });

        expect(renderDetailContent).toHaveBeenCalledTimes(1);
        expect(renderDetailContent).toHaveBeenCalledWith({ onRequestClose });
        expect(screen.findByTestId('detail:heavy-model-picker')).toBeTruthy();

        act(() => {
            screen.tree.unmount();
        });

        const reopenedScreen = await renderScreen(
            <AgentInputChipPickerDetailPane
                option={deferredOption}
                onApply={() => {}}
                applyLabel="Use"
                onSelectDetailOption={() => {}}
                onRequestClose={onRequestClose}
            />,
        );

        expect(renderDetailContent).toHaveBeenCalledTimes(2);
        expect(reopenedScreen.findByTestId('agent-input-chip-picker.detail-deferred-placeholder')).toBeNull();
        expect(reopenedScreen.findByTestId('detail:heavy-model-picker')).toBeTruthy();
    });
});
