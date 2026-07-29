import * as React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const deviceTypeState = vi.hoisted(() => ({ value: 'tablet' as 'phone' | 'tablet' }));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/settings/shell/SettingsShell', () => ({
    SettingsShell: (props: { children?: React.ReactNode }) => React.createElement('SettingsShell', null, props.children),
}));

vi.mock('@/components/navigation/RouteModalPortalScope', () => ({
    RouteModalPortalScope: (props: { children?: React.ReactNode }) => React.createElement('RouteModalPortalScope', null, props.children),
}));

vi.mock('@/components/navigation/createAppStackScreenOptions', () => ({
    createAppStackScreenOptions: () => ({}),
}));

vi.mock('@/utils/platform/platform', () => ({ isRunningOnMac: () => false }));

vi.mock('@/components/navigation/AppHeaderCloseButton', () => ({
    AppHeaderCloseButton: (props: Record<string, unknown>) => React.createElement('AppHeaderCloseButton', props),
}));

vi.mock('@/utils/navigation/safeRouterBack', () => ({ safeRouterBack: vi.fn() }));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

function indexScreenOptions(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const node = screen.tree.root
        .findAllByType('StackScreen')
        .find((candidate) => candidate.props.name === 'index');
    if (!node) throw new Error('Missing settings index Stack.Screen');
    return node.props.options as Record<string, unknown>;
}

describe('settings layout modal close affordance', () => {
    beforeEach(() => {
        deviceTypeState.value = 'tablet';
    });

    it('wraps settings content in the shared route-modal portal scope', async () => {
        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');
        const screen = await renderScreen(<SettingsLayoutRoute />);
        expect(screen.tree.root.findAllByType('RouteModalPortalScope').length).toBe(1);
    });

    it('removes the navigator header on tablet/desktop (modal) layouts', async () => {
        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');
        const screen = await renderScreen(<SettingsLayoutRoute />);
        expect(indexScreenOptions(screen).headerShown).toBe(false);
    });

    it('keeps the navigator header on phones (full-screen tab)', async () => {
        deviceTypeState.value = 'phone';
        const { default: SettingsLayoutRoute } = await import('@/app/(app)/settings/_layout');
        const screen = await renderScreen(<SettingsLayoutRoute />);
        expect(indexScreenOptions(screen).headerShown).not.toBe(false);
    });
});
