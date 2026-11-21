/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, expect, it, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

installTokenStorageWebPlatformMocks();
// Only native styling/icons and browser navigation are substituted; Account,
// bootstrap, declaration publication and workspace admission use production owners.
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/', segments: [] }).module);
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown is outside this Account restoration journey'); },
}));

vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
}));

await initializeRealAppRuntimeForTests();
const { AuthProvider, InjectedAuthProvider, useAuth } = await import('@/auth/context/AuthContext');
const { AppShellPluginUiProjectionProvider } = await import('../plugins/AppShellPluginUiProjection');
const { WorkspaceAppShellProvider } = await import('./WorkspaceAppShellProvider');
const { WorkspaceRouteEntry } = await import('./createWorkspaceRouteEntry');
const { WorkspaceShellWillHostRoutesContext } = await import('./WorkspaceRouteHostingContext');
const { useOptionalWorkspaceNavigation } = await import('./WorkspaceNavigationContext');
const { storage } = await import('@/sync/domains/state/storage');
const { saveSessionListWarmCacheEntries } = await import('@/sync/domains/state/warmCachePersistence');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { sync } = await import('@/sync/sync');
const { publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
afterAll(() => vi.unstubAllGlobals());

it('lets the live signed-out route commit its landing before the workspace takes over Home without presenting a temporary Home', async () => {
    const events: string[] = [];
    function Route() {
        const { isAuthenticated } = useAuth();
        const workspaceWillHostHome = React.useContext(WorkspaceShellWillHostRoutesContext);
        React.useLayoutEffect(() => {
            if (!isAuthenticated) return;
            events.push('first arrival');
            if (!workspaceWillHostHome) events.push('temporary Home presented');
        }, [isAuthenticated, workspaceWillHostHome]);
        React.useLayoutEffect(() => () => { events.push('route removed'); }, []);
        return React.createElement('PublicRoute');
    }
    const app = (credentials: Readonly<{ token: string }> | null) => <InjectedAuthProvider credentials={credentials}>
        <AppShellPluginUiProjectionProvider><WorkspaceAppShellProvider>
            <WorkspaceRouteEntry Body={Route} />
        </WorkspaceAppShellProvider></AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>;
    const screen = await renderScreen(app(null));
    try {
        expect(screen.root.findAllByType('PublicRoute')).toHaveLength(1);
        await screen.update(app({ token: 'first-arrival' }));
        expect(events).toEqual(['first arrival', 'route removed']);
        expect(screen.root.findAllByType('PublicRoute')).toHaveLength(0);
    } finally {
        await screen.unmount();
    }
});

it('admits the first Account workspace after real cold Sync restore reaches data-ready', async () => {
    const accountId = 'first-shell-restore';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
    const settingsStarted = createDeferred<void>();
    const settings = createDeferred<void>();
    const requests: string[] = [];
    const restoration = restoreServerAccountForTest({
        serverUrl: 'https://first-shell-restore.example.test', accountId, credentials,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            requests.push(path);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/account/settings') {
                settingsStarted.resolve();
                await settings.promise;
                return Response.json({ content: null, version: 0 });
            }
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends' || path === '/v1/friends/requests') return Response.json({ friends: [], requests: [] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    // Core admission waits for Settings/Profile first attempts, independently
    // of the optional encryption capability probe.
    await settingsStarted.promise;
    function WorkspaceRead() {
        const navigation = useOptionalWorkspaceNavigation();
        return React.createElement('AdmittedWorkspace', { catalog: navigation?.catalog, accountId: storage.getState().profileScope?.accountId });
    }
    const screen = await renderScreen(<AuthProvider initialCredentials={credentials}>
        <AppShellPluginUiProjectionProvider><WorkspaceAppShellProvider><WorkspaceRead /></WorkspaceAppShellProvider></AppShellPluginUiProjectionProvider>
    </AuthProvider>);
    try {
        expect(storage.getState().isDataReady).toBe(false);
        expect(screen.root.findAllByType('AdmittedWorkspace')).toHaveLength(0);
        await vi.waitFor(() => expect(screen.root.findAllByType('canvas').length).toBeGreaterThan(0));
        await act(async () => {
            settings.resolve();
            await restoration;
            await sync.awaitBootstrapForegroundAcquisition();
        });
        await vi.waitFor(() => {
            expect(storage.getState().isDataReady).toBe(true);
            expect(screen.root.findAllByType('AdmittedWorkspace')).toHaveLength(1);
        });
        expect(screen.root.findByType('AdmittedWorkspace').props.accountId).toBe(accountId);
        expect(screen.root.findByType('AdmittedWorkspace').props.catalog.length).toBeGreaterThan(0);
        expect(storage.getState().settingsVersion).toBe(0);
        expect(requests).toContain('/v1/account/profile');
        expect(requests).toContain('/v2/account/settings');
    } finally {
        settings.resolve();
        await screen.unmount();
        await (await restoration).dispose();
    }
});

it('admits Home with the exact Account’s retained Session rows while Settings refresh is pending', async () => {
    const accountId = 'warm-shell-restore';
    const serverId = 'srv_warm_shell_restore';
    const cachedSessionId = 'warm-home-session';
    const settingsStarted = createDeferred<void>();
    const settings = createDeferred<void>();
    saveSessionListWarmCacheEntries(serverId, accountId, {
        [cachedSessionId]: {
            sessionId: cachedSessionId, name: 'Retained Home Session', path: '/repo',
            metadataVersion: 1, agentStateVersion: 0, updatedAt: 2, createdAt: 1,
            active: false, activeAt: 2, archivedAt: null,
        },
    });
    const restoration = restoreServerAccountForTest({
        serverUrl: 'https://warm-shell-restore.example.test', serverIdentityId: serverId, accountId,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/account/settings') {
                settingsStarted.resolve();
                await settings.promise;
                return Response.json({ content: null, version: 0 });
            }
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    await settingsStarted.promise;
    const { credentials } = await restoration;
    function WorkspaceRead() {
        const active = useOptionalWorkspaceNavigation(value => value?.active === true);
        const retained = storage(state => state.sessionListRowsByServerId[serverId]?.[cachedSessionId]?.metadata?.name);
        return React.createElement('HomeSessionRow', { active, name: retained });
    }
    const screen = await renderScreen(<AuthProvider initialCredentials={credentials}>
        <AppShellPluginUiProjectionProvider><WorkspaceAppShellProvider><WorkspaceRead /></WorkspaceAppShellProvider></AppShellPluginUiProjectionProvider>
    </AuthProvider>);
    try {
        expect(storage.getState().isDataReady).toBe(false);
        expect(storage.getState().sessionListRowsByServerId[serverId]?.[cachedSessionId]?.metadata?.name)
            .toBe('Retained Home Session');
        await vi.waitFor(() => expect(screen.root.findByType('HomeSessionRow').props).toMatchObject({
            active: true, name: 'Retained Home Session',
        }));
        await act(async () => { settings.resolve(); });
        await vi.waitFor(() => {
            expect(storage.getState().isDataReady).toBe(true);
            expect(screen.root.findByType('HomeSessionRow').props.active).toBe(true);
        });
    } finally {
        settings.resolve();
        await screen.unmount();
        await (await restoration).dispose();
    }
});

it('shows the startup state, then the Home Retry, while the first Account waits on a disconnected Sync, and still admits it after', async () => {
    const accountId = 'first-shell-disconnected';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature` };
    const settingsStarted = createDeferred<void>();
    const settings = createDeferred<void>();
    const restoration = restoreServerAccountForTest({
        serverUrl: 'https://first-shell-disconnected.example.test', accountId, credentials,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/account/settings') {
                settingsStarted.resolve();
                await settings.promise;
                return Response.json({ content: null, version: 0 });
            }
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends' || path === '/v1/friends/requests') return Response.json({ friends: [], requests: [] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    await settingsStarted.promise;
    function WorkspaceRead() {
        const navigation = useOptionalWorkspaceNavigation();
        return React.createElement('AdmittedWorkspace', { catalog: navigation?.catalog });
    }
    const screen = await renderScreen(<AuthProvider initialCredentials={credentials}>
        <AppShellPluginUiProjectionProvider><WorkspaceAppShellProvider><WorkspaceRead /></WorkspaceAppShellProvider></AppShellPluginUiProjectionProvider>
    </AuthProvider>);
    const byTestId = (testID: string) => screen.root.findAll(node => node.props?.testID === testID);
    try {
        // Pending first Account: the navigator stays unmounted (the cold deep link waits), but the
        // person sees the startup state rather than an empty root.
        expect(storage.getState().isDataReady).toBe(false);
        expect(screen.root.findAllByType('AdmittedWorkspace')).toHaveLength(0);
        expect(byTestId('workspace-account-restoring').length).toBeGreaterThan(0);
        expect(byTestId('workspace-account-restoring-planet-still').length).toBeGreaterThan(0);
        expect(screen.root.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.includes('skeleton'))).toHaveLength(0);
        // The Home stops answering: the same unreachable state and Retry the app shows elsewhere.
        await act(async () => {
            publishAppliedActiveServerRuntimeAvailability(true);
            storage.setState({ endpointStatus: 'offline', socketStatus: 'disconnected', endpointReason: null, syncError: null });
        });
        await vi.waitFor(() => expect(byTestId('home-unreachable-retry').length).toBeGreaterThan(0));
        expect(screen.root.findAllByType('AdmittedWorkspace')).toHaveLength(0);
        // Sync comes back and data becomes ready: the workspace (and its deep link) is admitted.
        await act(async () => {
            storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
            settings.resolve();
            await restoration;
            await sync.awaitBootstrapForegroundAcquisition();
        });
        await vi.waitFor(() => {
            expect(storage.getState().isDataReady).toBe(true);
            expect(screen.root.findAllByType('AdmittedWorkspace')).toHaveLength(1);
        });
        expect(byTestId('workspace-account-restoring')).toHaveLength(0);
    } finally {
        settings.resolve();
        await screen.unmount();
        await (await restoration).dispose();
    }
});
