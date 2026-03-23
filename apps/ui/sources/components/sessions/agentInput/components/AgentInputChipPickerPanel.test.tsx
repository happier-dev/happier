import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#666',
                surface: '#fff',
                surfaceHigh: '#f2f2f2',
                divider: '#ddd',
                groupped: {
                    background: '#f2f2f2',
                    sectionTitle: '#777',
                },
                button: {
                    primary: { background: '#00f', tint: '#fff' },
                },
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

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
    AgentInputChipPickerDetailPane: (props: any) => React.createElement('AgentInputChipPickerDetailPane', props, null),
}));

vi.mock('./AgentInputChipPickerOptionSelector', () => ({
    AgentInputChipPickerOptionSelector: (props: any) => React.createElement('AgentInputChipPickerOptionSelector', props, null),
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

        expect(screen.tree.root.findAllByType('ScrollView')).toHaveLength(0);
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

        expect(screen.tree.root.findAllByType('ScrollView')).toHaveLength(0);
    });
});
