import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: 'View',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: 'SafeIonicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({
        pluginUiProjection: null,
        machineId: null,
        serverId: null,
        platform: 'ios',
    }),
}));

const appSidebarPlacement = {
    id: 'surfacePlacement:happier.dev.inspector:app-panel',
    pluginId: 'happier.dev.inspector',
    contributionKind: 'surfacePlacement',
    descriptorId: 'app-panel',
    placement: 'app.rightSidebarTab',
    target: { kind: 'app' },
    renderer: { kind: 'reactNative', rendererId: 'inspectorPanel' },
    display: { developerFallback: 'Inspector' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    order: 10,
    rightSidebar: {
        tabId: 'inspector',
        scope: 'app',
        section: 'plugin',
        order: 10,
        disabledPolicy: 'hide',
        collisionPolicy: 'reject',
        lifecycle: { retention: 'unmountOnDisable', unmountOnGenerationChange: true },
    },
} as const;

function projectionWith(...placements: readonly unknown[]): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        surfacePlacementsByPlacement: {
            'app.rightSidebarTab': placements,
        },
    } as unknown as PluginUiProjectionModel;
}

afterEach(() => {
    standardCleanup();
    routerPushSpy.mockClear();
});

describe('NativeAppPluginPanelsSettingsEntry', () => {
    it.each(['ios', 'android'] as const)(
        'exposes renderable app-scoped plugin panels through native settings navigation on %s',
        async (platform) => {
            const { NativeAppPluginPanelsSettingsEntry } = await import('./NativeAppPluginPanelsSettingsEntry');
            const screen = await renderScreen(
                <NativeAppPluginPanelsSettingsEntry
                    platform={platform}
                    pluginUiProjection={projectionWith(appSidebarPlacement)}
                />,
            );

            const entry = screen.findByTestId('settings.plugins.appPanels');
            expect(entry?.props.accessibilityLabel).toBe('settingsPlugins.appPanelsTitle');

            entry?.props.onPress();

            expect(routerPushSpy).toHaveBeenCalledWith('/settings/plugins/panels');
        },
    );

    it('does not advertise the native route when no app panel is renderable', async () => {
        const { NativeAppPluginPanelsSettingsEntry } = await import('./NativeAppPluginPanelsSettingsEntry');
        const screen = await renderScreen(
            <NativeAppPluginPanelsSettingsEntry
                platform="ios"
                pluginUiProjection={projectionWith({
                    ...appSidebarPlacement,
                    availability: { state: 'fallback', reason: 'feature_disabled', diagnostics: [] },
                })}
            />,
        );

        expect(screen.findByTestId('settings.plugins.appPanels')).toBeNull();
    });

    it('leaves the established web/desktop path unchanged', async () => {
        const { NativeAppPluginPanelsSettingsEntry } = await import('./NativeAppPluginPanelsSettingsEntry');
        const screen = await renderScreen(
            <NativeAppPluginPanelsSettingsEntry
                platform="web"
                pluginUiProjection={projectionWith(appSidebarPlacement)}
            />,
        );

        expect(screen.findByTestId('settings.plugins.appPanels')).toBeNull();
    });
});
