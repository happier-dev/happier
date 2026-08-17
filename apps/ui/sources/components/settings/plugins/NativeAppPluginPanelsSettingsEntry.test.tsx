import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';

const routerPushSpy = vi.hoisted(() => vi.fn());
const appShellProjectionState = vi.hoisted(() => ({
    value: null as PluginUiProjectionModel | null,
}));

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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({
        pluginUiProjection: appShellProjectionState.value,
        machineId: null,
        serverId: null,
        platform: 'ios',
    }),
}));

const appSidebarBinding = normalizePluginUiDestinationBindingV1({
    pluginId: 'happier.dev.inspector',
    destinationId: 'app-panel',
    rendererId: 'inspector-panel-renderer',
    container: 'rightSidebarTab',
    target: { kind: 'app' },
});
if (!appSidebarBinding) throw new Error('App panel fixture needs a normalized V2 binding');

const appSidebarPlacement = {
    id: 'surfacePlacement:happier.dev.inspector:app-panel',
    pluginId: 'happier.dev.inspector',
    contributionKind: 'surfacePlacement',
    descriptorId: 'app-panel',
    binding: appSidebarBinding,
    target: { kind: 'app' },
    renderer: { kind: 'reactNative', contributionId: 'inspector-panel-renderer' },
    display: { titleKey: 'app-panel', developerFallback: 'Inspector' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
    order: 10,
    rightSidebar: {
        scope: 'app',
        section: 'plugin',
        disabledPolicy: 'hide',
        collisionPolicy: 'reject',
        lifecycle: { retention: 'unmountOnDisable', unmountOnGenerationChange: true },
    },
} as const satisfies PluginUiSurfacePlacementProjection;

function projectionWith(...placements: readonly PluginUiSurfacePlacementProjection[]): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        surfacePlacementsById: Object.freeze(Object.fromEntries(placements.map((entry) => [entry.id, entry]))),
    };
}

afterEach(() => {
    standardCleanup();
    routerPushSpy.mockClear();
    appShellProjectionState.value = null;
});

describe('NativeAppPluginPanelsSettingsEntry', () => {
    it.each(['ios', 'android'] as const)(
        'exposes renderable app-scoped plugin panels through native settings navigation on %s',
        async (platform) => {
            const { NativeAppPluginPanelsSettingsEntry } = await import('./NativeAppPluginPanelsSettingsEntry');
            appShellProjectionState.value = projectionWith(appSidebarPlacement);
            const screen = await renderScreen(
                <NativeAppPluginPanelsSettingsEntry
                    platform={platform}
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
        appShellProjectionState.value = projectionWith({
            ...appSidebarPlacement,
            availability: { state: 'fallback', reason: 'feature_disabled', diagnostics: [] },
        });
        const screen = await renderScreen(
            <NativeAppPluginPanelsSettingsEntry
                platform="ios"
            />,
        );

        expect(screen.findByTestId('settings.plugins.appPanels')).toBeNull();
    });

    it('leaves the established web/desktop path unchanged', async () => {
        const { NativeAppPluginPanelsSettingsEntry } = await import('./NativeAppPluginPanelsSettingsEntry');
        appShellProjectionState.value = projectionWith(appSidebarPlacement);
        const screen = await renderScreen(
            <NativeAppPluginPanelsSettingsEntry
                platform="web"
            />,
        );

        expect(screen.findByTestId('settings.plugins.appPanels')).toBeNull();
    });
});
