import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('View', props, props.children),
                                Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('Pressable', props, props.children),
                            }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#666',
                surface: '#fff',
                surfaceSelected: '#f7f7f7',
                radio: { active: '#00f' },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

describe('AgentInputSelectionSimpleList', () => {
    it('renders the title and options and marks the selected option', async () => {
        const { AgentInputSelectionSimpleList } = await import('./AgentInputSelectionSimpleList');
        const onSelect = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<AgentInputSelectionSimpleList
                    title="Mode"
                    options={[
                        { id: 'build', label: 'Build', subtitle: 'Default behavior' },
                        { id: 'plan', label: 'Plan', subtitle: 'Think first' },
                    ]}
                    selectedOptionId="build"
                    onSelect={onSelect}
                />)).tree;

        expect(tree).not.toBeNull();
        const root = tree!.root;

        expect(root.findByProps({ children: 'Mode' })).toBeTruthy();
        expect(root.findByProps({ testID: 'agent-input-simple-option:plan' })).toBeTruthy();
        expect(root.findAllByType('Ionicons')).toHaveLength(1);

        await act(async () => {
            root.findByProps({ testID: 'agent-input-simple-option:plan' }).props.onPress();
        });

        expect(onSelect).toHaveBeenCalledWith('plan');
    });
});
