import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks();

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: (props: any) => React.createElement('ItemListStatic', props, props.children),
}));

vi.mock('./AgentInputChipPickerDetailPane', () => ({
    AgentInputChipPickerDetailPane: (props: any) =>
        React.createElement('AgentInputChipPickerDetailPane', {
            ...props,
            testID: 'agent-input-chip-picker.detail-pane',
        }, null),
}));

vi.mock('./AgentInputChipPickerOptionSelector', () => ({
    AgentInputChipPickerOptionSelector: (props: any) =>
        React.createElement('AgentInputChipPickerOptionSelector', {
            ...props,
            testID: 'agent-input-chip-picker.option-rail',
        }, null),
}));

describe('AgentInputChipPickerPanel', () => {
    it('does not render inner scroll views in simple mode', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                { id: 'one', label: 'One' } as any,
                { id: 'two', label: 'Two' } as any,
            ]}
            selectedOptionId="one"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.title')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.option:one')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.option:two')).toBeTruthy();
    });

    it('does not render inner scroll views in detailed mode', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');

        const screen = await renderScreen(<AgentInputChipPickerPanel
            title="Pick"
            options={[
                { id: 'one', label: 'One', detailDescription: 'Primary checkout' } as any,
                { id: 'two', label: 'Two', detailDescription: 'Feature checkout' } as any,
            ]}
            selectedOptionId="one"
            onSelect={() => {}}
            onRequestClose={() => {}}
        />);

        expect(screen.findByTestId('agent-input-chip-picker')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.title')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.option-rail')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.detail-pane')).toBeTruthy();
    });
});
