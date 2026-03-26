import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: ({ name, ...props }: any) => React.createElement('Ionicons', { name, ...props }),
    Octicons: ({ name, ...props }: any) => React.createElement('Octicons', { name, ...props }),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

describe('Agent input action chips (native E2E testID accessibility)', () => {
    it('maps chip testIDs into accessibilityLabel when native E2E labels are enabled', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = '1';
        try {
            const { createAgentSelectionActionChip } = await import('./createAgentSelectionActionChip');
            const { createPermissionActionChip } = await import('./createPermissionActionChip');
            const { createProfileActionChip } = await import('./createProfileActionChip');
            const { createSessionModeActionChip } = await import('./createSessionModeActionChip');

            const anchorRef = { current: null } as any;
            const base = {
                anchorRef,
                tint: '#000',
                showLabel: true,
                label: 'X',
                chipStyle: () => ({}),
                textStyle: {},
                onPress: () => {},
            };

            const chips = [
                createAgentSelectionActionChip(base as any),
                createPermissionActionChip(base as any),
                createProfileActionChip(base as any),
                createSessionModeActionChip(base as any),
            ];

            const ids = chips.map((chip) => (chip as any)?.props?.testID);
            expect(ids).toEqual([
                'agent-input-agent-chip',
                'agent-input-permission-chip',
                'agent-input-profile-chip',
                'agent-input-session-mode-chip',
            ]);

            const labels = chips.map((chip) => (chip as any)?.props?.accessibilityLabel);
            expect(labels).toEqual(ids);
        } finally {
            if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
            else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = previous;
        }
    });
});
