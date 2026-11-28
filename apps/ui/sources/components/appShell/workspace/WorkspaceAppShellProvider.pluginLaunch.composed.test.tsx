/** @vitest-environment jsdom */
import * as React from 'react';
import { Dimensions } from 'react-native';
import { afterAll, expect, it, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';

installTokenStorageWebPlatformMocks();
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/' }).module);
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown is outside plugin route admission'); },
}));
vi.stubGlobal('matchMedia', (media: string) => ({
    media, matches: false, addEventListener() {}, removeEventListener() {},
}));
afterAll(() => vi.unstubAllGlobals());

await initializeRealAppRuntimeForTests();

it('keeps a cold compact PR address and curtain while the first plugin catalog is pending', async () => {
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { WorkspaceAppShellProvider } = await import('./WorkspaceAppShellProvider');
    const { AppShellPluginUiProjectionValueProvider } = await import('../plugins/AppShellPluginUiProjection');
    const { useOptionalWorkspaceNavigation } = await import('./WorkspaceNavigationContext');
    const { buildPluginAppPageRoutePath } = await import('@/components/plugins/pages/pluginPageRoute');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const { sync } = await import('@/sync/sync');

    const pluginId = 'happier.triage';
    const localId = 'triage';
    const subPath = 'sv,assigned/' + buildTriageEntryRouteSegmentV1({
        source: { pluginId: 'happier.scm.forge.github', localId: 'pull-requests' },
        kindId: 'pull-request', collisionScope: 'repository', entryId: '54',
    });
    const href = buildPluginAppPageRoutePath({ pluginId, localId, subPath });
    const previousHref = window.location.href;
    window.history.replaceState(null, '', href);

    const accountId = 'compact-cold-plugin';
    const restored = await restoreServerAccountForTest({
        serverUrl: 'https://compact-cold-plugin.example.test', accountId,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    await sync.awaitBootstrapForegroundAcquisition();
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(lifetime?.scope.accountId).toBe(accountId);
    const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const launch = startTestLaunchCurtain();
    function Destination() {
        const navigation = useOptionalWorkspaceNavigation();
        if (!navigation?.active) return null;
        const state = navigation.state;
        const tab = state.tabs[state.groups[state.focusedGroupId].activeTabId];
        return React.createElement('LaunchDestination', { target: tab.target, phone: navigation.phone != null });
    }
    const noop = () => {};
    const app = (ready: boolean) => <AuthProvider initialCredentials={restored.credentials}>
        <AppShellPluginUiProjectionValueProvider declarationReady={ready} value={{
            pluginUiProjection: ready ? EMPTY_PLUGIN_UI_PROJECTION : null,
            pluginBrowserProjection: null, phase: ready ? 'current' : 'establishing',
            accountLifetime: lifetime, interactionEnabled: false, machineId: null,
            serverId: lifetime?.scope.serverId ?? null, platform: 'web',
            clientExecutableActivation: { status: 'establishing' },
            reloadConnectedAccountProjection: noop, reloadClientExecutables: noop,
        }}>
            <WorkspaceAppShellProvider><Destination /></WorkspaceAppShellProvider>
        </AppShellPluginUiProjectionValueProvider>
        <CurtainProbe />
    </AuthProvider>;
    const screen = await renderScreen(app(false));
    try {
        launch.releaseShell();
        await launch.paint();
        const pendingCurtain = screen.root.findByType('CurtainProbe').props.state;
        // Expo may emit its initial Home index while its linked child is still mounting.
        window.history.replaceState(null, '', '/');
        await screen.update(app(true));
        const destination = screen.root.findByType('LaunchDestination').props;
        expect({ pendingCurtain, destination }).toEqual({
            pendingCurtain: 'up',
            destination: { phone: true, target: { kind: 'plugin:happier.triage:triage', params: { pluginId, localId, subPath } } },
        });
        expect(window.location.pathname).toBe(href);
    } finally {
        await screen.unmount();
        launch.dispose();
        dimensions.mockRestore();
        window.history.replaceState(null, '', previousHref);
        await restored.dispose();
    }
});
