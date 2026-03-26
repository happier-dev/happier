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
                groupped: { background: '#fff' },
                surfacePressedOverlay: '#eee',
                surfacePressed: '#eee',
                text: '#111',
                textSecondary: '#666',
                divider: '#ddd',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: ({ name, ...props }: any) => React.createElement('Ionicons', { name, ...props }),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('./AgentInputChipPickerTopSelector', () => ({
    AgentInputChipPickerTopSelector: () => null,
}));

describe('AgentInputChipPickerOptionSelector (native E2E testID accessibility)', () => {
    it('maps option testIDs into accessibilityLabel when native E2E labels are enabled', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = '1';
        try {
            const { AgentInputChipPickerOptionSelector } = await import('./AgentInputChipPickerOptionSelector');

            const tree = React.createElement(AgentInputChipPickerOptionSelector as any, {
                sections: [
                    {
                        id: 'agents',
                        label: null,
                        options: [{ id: 'agent:codex', label: 'Codex' }],
                    },
                ],
                focusedOptionId: 'agent:codex',
                selectedOptionId: 'agent:codex',
                onFocusOption: () => {},
                variant: 'rail',
            });

            const { renderScreen } = await import('@/dev/testkit');
            const screen = await renderScreen(tree);

            const option = screen.findByTestId('agent-input-chip-picker.option:agent:codex');
            expect(option?.props?.accessibilityLabel).toBe('agent-input-chip-picker.option:agent:codex');
        } finally {
            if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
            else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = previous;
        }
    });
});
