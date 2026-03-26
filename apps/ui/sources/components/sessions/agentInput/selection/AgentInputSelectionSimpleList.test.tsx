import * as React from 'react';
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

        const screen = await renderScreen(
            <AgentInputSelectionSimpleList
                title="Mode"
                options={[
                    { id: 'build', label: 'Build', subtitle: 'Default behavior' },
                    { id: 'plan', label: 'Plan', subtitle: 'Think first' },
                ]}
                selectedOptionId="build"
                onSelect={onSelect}
            />,
        );

        expect(screen.tree.toJSON()).not.toBeNull();
        expect(screen.findByProps({ children: 'Mode' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'agent-input-simple-option:plan' })).toBeTruthy();
        expect(screen.findAllByType('Ionicons')).toHaveLength(1);

        await screen.pressByTestIdAsync('agent-input-simple-option:plan');

        expect(onSelect).toHaveBeenCalledWith('plan');
    });

    it('maps option testIDs into accessibilityLabel when native E2E labels are enabled', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = '1';
        try {
            const { AgentInputSelectionSimpleList } = await import('./AgentInputSelectionSimpleList');

            const screen = await renderScreen(
                <AgentInputSelectionSimpleList
                    title="Mode"
                    options={[
                        { id: 'build', label: 'Build' },
                        { id: 'plan', label: 'Plan' },
                    ]}
                    selectedOptionId="build"
                    onSelect={() => {}}
                />,
            );

            const plan = screen.findByTestId('agent-input-simple-option:plan');
            expect(plan?.props?.accessibilityLabel).toBe('agent-input-simple-option:plan');
        } finally {
            if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
            else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = previous;
        }
    });
});
