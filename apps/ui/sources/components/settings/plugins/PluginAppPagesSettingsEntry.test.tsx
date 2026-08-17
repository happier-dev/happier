import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

type MockItemProps = Record<string, unknown> & Readonly<{
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
}>;

const routerPush = vi.hoisted(() => vi.fn());
const activatePluginAppPage = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: MockItemProps) => React.createElement('Item', props, props.title, props.subtitle),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => `localized:${key}` });
});

vi.mock('@/components/appShell/plugins/pluginAppPageNavigation', () => ({
    usePluginAppPageLaunchInputStaging: () => vi.fn(() => true),
    usePluginAppPageCatalogActivationHandler: () => activatePluginAppPage,
}));

vi.mock('@/components/appShell/destinations/compactAppDestinationCatalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/destinations/compactAppDestinationCatalog')>()),
    useCompactAppDestinations: () => [{
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:notes',
        destination: { pluginId: 'acme.notes', localId: 'notes' },
        title: 'Notes',
        icon: 'note',
        group: 'plugins',
        order: 10,
        routePath: '/plugins/acme.notes/notes',
        availability: 'unavailable',
        unavailableReason: 'feature_disabled',
        badge: { label: 'Preview', tone: 'accent' },
    }],
}));

afterEach(() => {
    standardCleanup();
    routerPush.mockClear();
    activatePluginAppPage.mockClear();
});

describe('PluginAppPagesSettingsEntry', () => {
    it('renders localized plugin-runtime copy instead of the raw unavailable reason', async () => {
        const { PluginAppPagesSettingsEntry } = await import('./PluginAppPagesSettingsEntry');
        const screen = await renderScreen(<PluginAppPagesSettingsEntry />);
        const entry = screen.findByTestId('settings.plugins.appPages.plugin:acme.notes:notes');

        expect(entry?.props.subtitle).toBe('localized:pluginRuntime.disabledByPolicy');
        expect(screen.getTextContent()).not.toContain('feature_disabled');
        expect(entry?.props.rightElement).toBeTruthy();
    });
});
