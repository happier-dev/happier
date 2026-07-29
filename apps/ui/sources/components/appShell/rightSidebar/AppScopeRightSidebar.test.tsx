import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const endpointConnectivityState = vi.hoisted(() => ({
    status: 'online' as 'online' | 'offline',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: any) => React.createElement(
        'View',
        {
            testID: `plugin-host-renderer-${props.placement?.renderer?.rendererId ?? props.placement?.descriptorId ?? 'unknown'}`,
            'data-plugin-interaction-state': props.hostApi ? 'enabled' : 'offline-snapshot',
        },
    ),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/storage')>(),
    useEndpointStatus: () => endpointConnectivityState.status,
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
        platform: 'web',
    }),
}));

const appSidebarPlacement = {
    id: 'surfacePlacement:acme:app-panel',
    pluginId: 'acme',
    contributionKind: 'surfacePlacement',
    descriptorId: 'app-panel',
    placement: 'app.rightSidebarTab',
    target: { kind: 'app' },
    renderer: { kind: 'host', rendererId: 'descriptorPanel' },
    display: { developerFallback: 'Acme app panel' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    order: 10,
    rightSidebar: {
        tabId: 'acme-app',
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

describe('AppScopeRightSidebar', () => {
    beforeEach(() => {
        endpointConnectivityState.status = 'online';
    });

    it('mounts an available app-scope plugin tab surface through the canonical host', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                pluginUiProjection={projectionWith(appSidebarPlacement)}
                platform="web"
                testID="app-scope-right-sidebar"
            />,
        );

        expect(screen.findByTestId('app-scope-right-sidebar-tab:plugin:acme:acme-app')).toBeTruthy();
        expect(screen.findByTestId('plugin-host-renderer-descriptorPanel')).toBeTruthy();
    });

    it('withholds the app-scope host API while the endpoint is offline', async () => {
        endpointConnectivityState.status = 'offline';
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');
        const renderElement = () => (
            <AppScopeRightSidebar
                pluginUiProjection={projectionWith(appSidebarPlacement)}
                platform="web"
            />
        );

        const screen = await renderScreen(renderElement());

        expect(
            screen.findByTestId('plugin-host-renderer-descriptorPanel')?.props['data-plugin-interaction-state'],
        ).toBe('offline-snapshot');

        endpointConnectivityState.status = 'online';
        await screen.update(renderElement());
        expect(
            screen.findByTestId('plugin-host-renderer-descriptorPanel')?.props['data-plugin-interaction-state'],
        ).toBe('enabled');
    });

    it('renders the empty state when no app-scope plugin tabs are available', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                pluginUiProjection={projectionWith()}
                platform="web"
                testID="app-scope-right-sidebar-empty"
            />,
        );

        expect(screen.findByTestId('app-scope-right-sidebar-empty')).toBeTruthy();
        expect(screen.findByTestId('plugin-host-renderer-descriptorPanel')).toBeNull();
    });

    it('does not mount a fallback/unavailable plugin tab surface (fail-closed)', async () => {
        const { AppScopeRightSidebar } = await import('./AppScopeRightSidebar');

        const screen = await renderScreen(
            <AppScopeRightSidebar
                pluginUiProjection={projectionWith({
                    ...appSidebarPlacement,
                    availability: { state: 'fallback', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
                })}
                platform="web"
                testID="app-scope-right-sidebar-deferred"
            />,
        );

        // The disabled-by-default tab is hidden, so the surface renders the empty state.
        expect(screen.findByTestId('plugin-host-renderer-descriptorPanel')).toBeNull();
    });
});
