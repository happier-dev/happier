import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const appScopeRightSidebarSpy = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ pluginId: undefined as string | undefined, destinationId: undefined as string | undefined }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: () => routeParams,
    }).module;
});

vi.mock('@/components/appShell/rightSidebar/AppScopeRightSidebar', () => ({
    AppScopeRightSidebar: (props: Record<string, unknown>) => {
        appScopeRightSidebarSpy(props);
        return React.createElement('AppScopeRightSidebar', props);
    },
}));

describe('plugin app panels settings route', () => {
    it('mounts the canonical app-scoped right-sidebar host', async () => {
        const { default: PluginAppPanelsSettingsRoute } = await import(
            '@/app/(app)/settings/plugins/panels'
        );
        const screen = await renderScreen(<PluginAppPanelsSettingsRoute />);

        expect(screen.findByTestId('settings.plugins.appPanels.host')).toBeTruthy();
        expect(appScopeRightSidebarSpy).toHaveBeenCalledWith(expect.objectContaining({
            testID: 'settings.plugins.appPanels.host',
        }));
    });

    it('hands an exact qualified catalog destination to the canonical sidebar host', async () => {
        routeParams.pluginId = 'acme.review';
        routeParams.destinationId = 'review-panel';
        const { default: PluginAppPanelsSettingsRoute } = await import(
            '@/app/(app)/settings/plugins/panels'
        );

        await renderScreen(<PluginAppPanelsSettingsRoute />);

        expect(appScopeRightSidebarSpy).toHaveBeenCalledWith(expect.objectContaining({
            requestedDestination: { pluginId: 'acme.review', localId: 'review-panel' },
        }));
    });
});
