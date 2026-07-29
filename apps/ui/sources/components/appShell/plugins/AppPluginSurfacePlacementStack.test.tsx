import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const placementStackSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementStack: (props: unknown) => {
        placementStackSpy(props);
        return React.createElement('PluginSurfacePlacementStackMock', { props });
    },
}));

afterEach(() => {
    standardCleanup();
    placementStackSpy.mockClear();
});

const pluginUiProjection = {
    generation: 1,
    translationsByPluginId: {},
    structuredMessagesByKind: {},
    sessionHeaderActionsById: {},
    hostedWebById: {},
    reactNativeBundlesById: {},
    surfacePlacementsById: {
        'surfacePlacement:acme.preview:settings': {
            id: 'surfacePlacement:acme.preview:settings',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'settings',
            placement: 'app.settingsPage',
            target: { kind: 'app' },
            renderer: { kind: 'hostedWeb', contributionId: 'preview-web' },
            display: { titleKey: 'title' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
    },
    surfacePlacementsByPlacement: {
        'app.settingsPage': [{
            id: 'surfacePlacement:acme.preview:settings',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'settings',
            placement: 'app.settingsPage',
            target: { kind: 'app' },
            renderer: { kind: 'hostedWeb', contributionId: 'preview-web' },
            display: { titleKey: 'title' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        }],
    },
    uiArtifactsById: {},
    digestsByPluginId: {},
    voiceProvidersById: {},
    unknownEntriesById: {},
} satisfies PluginUiProjectionModel;

describe('AppPluginSurfacePlacementStack', () => {
    it('passes app-shell projection context to the shared plugin placement stack', async () => {
        const {
            AppPluginSurfacePlacementStack,
            AppShellPluginUiProjectionValueProvider,
        } = await import('./AppShellPluginUiProjection');

        await renderScreen(
            <AppShellPluginUiProjectionValueProvider
                value={{
                    pluginUiProjection,
                    pluginBrowserProjection: null,
                    interactionEnabled: true,
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    platform: 'web',
                }}
            >
                <AppPluginSurfacePlacementStack placement="app.settingsPage" testID="settings-plugin-stack" />
            </AppShellPluginUiProjectionValueProvider>,
        );

        expect(placementStackSpy).toHaveBeenCalledWith(expect.objectContaining({
            placement: 'app.settingsPage',
            pluginUiProjection,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
            testID: 'settings-plugin-stack',
        }));
    });

    it('fails closed when no app-shell projection is available', async () => {
        const { AppPluginSurfacePlacementStack } = await import('./AppShellPluginUiProjection');

        await renderScreen(
            <AppPluginSurfacePlacementStack placement="app.settingsPage" testID="settings-plugin-stack" />,
        );

        expect(placementStackSpy).not.toHaveBeenCalled();
    });
});
