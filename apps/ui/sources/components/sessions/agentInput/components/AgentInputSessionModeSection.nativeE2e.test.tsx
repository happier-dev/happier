import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                button: { primary: { background: '#000' } },
                text: '#111',
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: ({ name, ...props }: any) => React.createElement('Ionicons', { name, ...props }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('AgentInputSessionModeSection (native E2E testID accessibility)', () => {
    it('maps option testIDs into accessibilityLabel when native E2E labels are enabled', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = '1';
        try {
            const { AgentInputSessionModeSection } = await import('./AgentInputSessionModeSection');
            const { renderScreen } = await import('@/dev/testkit');

            const screen = await renderScreen(
                <AgentInputSessionModeSection
                    options={[
                        { id: 'build', name: 'Build', description: 'Default' },
                        { id: 'plan', name: 'Plan', description: 'Think first' },
                    ]}
                    selectedOptionId="build"
                    onSelectOption={() => {}}
                />,
            );

            const plan = screen.findByTestId('agent-input-session-mode-option:plan');
            expect(plan?.props?.accessibilityLabel).toBe('agent-input-session-mode-option:plan');
        } finally {
            if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
            else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = previous;
        }
    });
});
