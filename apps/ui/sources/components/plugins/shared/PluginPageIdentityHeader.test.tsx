import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Cold compilation belongs to collection, outside the per-test timeout.
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { PluginPageIdentityHeaderProvider } = await import('./PluginPageIdentityHeader');
const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');

describe('PluginPageIdentityHeaderProvider', () => {
    it('keeps the page header quiet during Connected Account projection updates', async () => {
        const commits = vi.fn();
        const header = (
            <React.Profiler id="plugin-page-identity" onRender={commits}>
                <PluginPageIdentityHeaderProvider pluginId="acme.sandboxes" title="Sandboxes">
                    {null}
                </PluginPageIdentityHeaderProvider>
            </React.Profiler>
        );
        type Projection = React.ComponentProps<typeof AppShellPluginUiProjectionValueProvider>['value'];
        const value: Projection = {
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: null,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        const render = (next: Projection) => (
            <AppShellPluginUiProjectionValueProvider value={next}>
                {header}
            </AppShellPluginUiProjectionValueProvider>
        );
        const screen = await renderScreen(render(value));
        try {
            expect(commits).toHaveBeenCalled();
            commits.mockClear();
            for (let revision = 1; revision <= 20; revision += 1) {
                await screen.update(render({ ...value, connectedAccountProjectionRevision: revision }));
            }
            expect(commits).toHaveBeenCalledTimes(0);

            await screen.update(render({ ...value, serverId: 'new-server' }));
            expect(commits).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
        }
    });

    // A page that has not loaded keeps its identity above its cold state, unless a host page around it (a Machine
    // page's tab) already names it: then the cold state stands under the host's header alone.
    it.each([
        ['page', true],
        ['host', false],
    ] as const)('with %s identity, a cold page shows its own header: %s', async (identityOwner, shown) => {
        const screen = await renderScreen(
            <PluginPageIdentityHeaderProvider pluginId="acme.sandboxes" title="Sandboxes" identityOwner={identityOwner}>
                <PluginSurfaceInteractionBoundary surfaceId="cold-page" snapshotTitle="Sandboxes" enabled={false}>
                    {null}
                </PluginSurfaceInteractionBoundary>
            </PluginPageIdentityHeaderProvider>,
        );
        try {
            expect(screen.findByTestId('plugin-page-identity-header:acme.sandboxes') !== null).toBe(shown);
        } finally {
            await screen.unmount();
        }
    });

    it('says a phone toolbar page\'s identity as the large title its Collection leads with, not an entity header', async () => {
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const screen = await renderScreen(
            <PluginPageIdentityHeaderProvider pluginId="happier.triage" title="PRs & Issues" headerStyle="toolbar" largeTitle>
                <PluginSurfaceInteractionBoundary surfaceId="cold-page" snapshotTitle="PRs & Issues" enabled={false}>
                    {null}
                </PluginSurfaceInteractionBoundary>
            </PluginPageIdentityHeaderProvider>,
        );
        try {
            const header = screen.findByType(PageHeader);
            expect(header.props).toMatchObject({ title: 'PRs & Issues', alwaysShowTitle: true });
            // The loaded page draws the name alone (lab `merged-list` 390): no mark, so nothing moves on arrival.
            expect(header.props.leading).toBeUndefined();
            expect(screen.findByTestId('plugin-page-identity-toolbar:happier.triage')).toBeNull();
        } finally {
            await screen.unmount();
        }
    });
});
