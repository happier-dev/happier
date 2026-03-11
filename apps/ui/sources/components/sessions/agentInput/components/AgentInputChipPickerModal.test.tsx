import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { AgentInputChipPickerModal } from './AgentInputChipPickerModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#666',
                surface: '#fff',
                backgroundSecondary: '#f5f5f5',
                card: { background: '#f8f8f8' },
                status: { connected: '#0f0' },
                button: {
                    primary: { background: '#00f', tint: '#fff' },
                },
                groupped: {
                    border: '#ddd',
                    separator: '#eee',
                    sectionTitle: '#777',
                },
                input: {
                    background: '#fafafa',
                },
            },
        },
    }),
    StyleSheet: { create: (factory: any) => factory({
        colors: {
            text: '#111',
            textSecondary: '#666',
            surface: '#fff',
            backgroundSecondary: '#f5f5f5',
            card: { background: '#f8f8f8' },
            status: { connected: '#0f0' },
            button: {
                primary: { background: '#00f', tint: '#fff' },
            },
            groupped: {
                border: '#ddd',
                separator: '#eee',
                sectionTitle: '#777',
            },
            input: {
                background: '#fafafa',
            },
        },
    }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('AgentInputChipPickerModal', () => {
    it('selects immediately in the simple single-column mode', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        { id: 'one', label: 'One' },
                        { id: 'two', label: 'Two' },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const item = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            item.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onClose).toHaveBeenCalled();
    });

    it('uses the detail pane and explicit apply action when options include detail metadata', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Primary',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Primary checkout',
                        },
                        {
                            id: 'two',
                            label: 'Feature',
                            sectionId: 'linked',
                            sectionLabel: 'Linked',
                            detailDescription: 'Feature checkout',
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const option = tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:two' });
        await act(async () => {
            option.props.onPress();
        });

        expect(onSelect).not.toHaveBeenCalled();

        const apply = tree!.root.findByProps({ testID: 'agent-input-chip-picker.apply' });
        await act(async () => {
            apply.props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('two');
        expect(onClose).toHaveBeenCalled();
    });

    it('renders an optional detail action without replacing the default apply flow', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const onDetailAction = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <AgentInputChipPickerModal
                    title="Pick"
                    options={[
                        {
                            id: 'one',
                            label: 'Current folder',
                            sectionId: 'current',
                            sectionLabel: 'Current',
                            detailDescription: 'Current linked workspace',
                            detailActionLabel: 'Open Settings',
                            onDetailAction,
                        },
                    ]}
                    selectedOptionId="one"
                    onSelect={onSelect}
                    onClose={onClose}
                />,
            );
        });

        const detailAction = tree!.root.findByProps({ testID: 'agent-input-chip-picker.detail-action' });
        await act(async () => {
            detailAction.props.onPress();
        });

        expect(onDetailAction).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });
});
