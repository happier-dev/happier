import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    uiText: async () => ({
        Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: ({ name, ...props }: any) => React.createElement('Ionicons', { name, ...props }),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => ({ rowIndex: 0, rowCount: 1 }),
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({ borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }),
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => ({ titleKey: 'titleComfortable', subtitleKey: 'subtitleComfortable', detailKey: 'detailComfortable', iconSize: 20, iconMarginRight: 10, chevronSize: 12 }),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

describe('Item (native E2E testID accessibility)', () => {
    afterEach(standardCleanup);

    it('maps Item testID into accessibilityLabel when native E2E labels are enabled', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
        const previousDev = (globalThis as any).__DEV__;
        process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = '1';
        try {
            (globalThis as any).__DEV__ = true;
            const { resolveAutomationTestIdLabelEnabled } = await import('@/dev/automation/automationTestId');
            expect(resolveAutomationTestIdLabelEnabled()).toBe(true);

            const { Item } = await import('./Item');
            const screen = await renderScreen(<Item testID="server-settings-add-server-toggle" title="X" onPress={() => {}} />);
            const matches = screen.findAllByProps({ testID: 'server-settings-add-server-toggle' });
            expect(matches.length).toBeGreaterThan(0);
            expect(matches.map((entry) => entry.props.accessibilityLabel)).toContain('server-settings-add-server-toggle');
        } finally {
            if (previous === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS;
            else process.env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS = previous;
            if (previousDev === undefined) delete (globalThis as any).__DEV__;
            else (globalThis as any).__DEV__ = previousDev;
        }
    });
});
