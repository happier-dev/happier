import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({ module: null as null | { isSupported?: boolean }, view: vi.fn() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => boundary.module,
    requireNativeViewManager: () => {
        boundary.view();
        return (props: Record<string, unknown>) => React.createElement('NativeSystemTabBar', props);
    },
}));

describe('system tab bar native capability admission', () => {
    it.each([
        ['missing module', null, false],
        ['older module without a capability declaration', {}, false],
        ['unsupported native runtime', { isSupported: false }, false],
        ['supported native runtime', { isSupported: true }, true],
    ] as const)('uses the native bar only for a supported declaration: %s', async (_name, module, available) => {
        vi.resetModules();
        boundary.module = module;
        boundary.view.mockClear();
        const { SystemTabBar, systemTabBarAvailable } = await import('./SystemTabBar');
        expect(systemTabBarAvailable).toBe(available);
        const screen = await renderScreen(<SystemTabBar items={[]} selectedId="sessions" hidden={false}
            showLabels={true} tintColor="#000000" onPress={() => {}} />);
        expect(screen.tree.root.findAllByType('NativeSystemTabBar' as never)).toHaveLength(available ? 1 : 0);
        expect(boundary.view).toHaveBeenCalledTimes(available ? 1 : 0);
        standardCleanup();
    });
});
