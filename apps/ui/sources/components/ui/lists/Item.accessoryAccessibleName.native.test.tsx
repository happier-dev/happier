import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';

import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'android' });
    },
});

/** Pin one native `react-native` for the whole module graph — see `Item.webTestId.test.tsx`. */
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

/**
 * Native has no ARIA attribute to query: React Native's `Switch` carries the switch
 * trait itself, and `accessibilityLabel` on that host node IS the name VoiceOver /
 * TalkBack announce. So the platform equivalent of "find by role" is "find the
 * switch host", and the name is read off that same node.
 */
function findSwitchHosts(screen: RenderScreenResult): ReactTestInstance[] {
    return screen.findAll((node) => String(node.type) === 'Switch');
}

describe('Item accessory accessible name (native)', () => {
    it('names an unlabelled switch accessory with the row title', async () => {
        const { Item } = await import('./Item');
        const { Switch } = await import('@/components/ui/forms/Switch');

        const screen = await renderScreen(
            <Item
                title="Environment badge"
                subtitle="Show which environment this build points at"
                rightElement={<Switch value={false} onValueChange={() => {}} />}
                showChevron={false}
            />,
        );

        const switches = findSwitchHosts(screen);
        expect(switches).toHaveLength(1);
        expect(switches[0]!.props.accessibilityLabel).toBe('Environment badge');
    });

    it('keeps an explicit switch label instead of the row title', async () => {
        const { Item } = await import('./Item');
        const { Switch } = await import('@/components/ui/forms/Switch');

        const screen = await renderScreen(
            <Item
                title="Diagnostics"
                rightElement={(
                    <Switch
                        value={false}
                        onValueChange={() => {}}
                        accessibilityLabel="Record voice diagnostics"
                    />
                )}
                showChevron={false}
            />,
        );

        const switches = findSwitchHosts(screen);
        expect(switches).toHaveLength(1);
        expect(switches[0]!.props.accessibilityLabel).toBe('Record voice diagnostics');
    });

    it('leaves a standalone switch outside any row unnamed rather than inventing copy', async () => {
        const { Switch } = await import('@/components/ui/forms/Switch');

        const screen = await renderScreen(<Switch value={false} onValueChange={() => {}} />);

        const switches = findSwitchHosts(screen);
        expect(switches).toHaveLength(1);
        expect(switches[0]!.props.accessibilityLabel).toBeUndefined();
    });
});
