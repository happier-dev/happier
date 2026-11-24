import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const route = vi.hoisted(() => ({ pathname: '/' }));
installTokenStorageWebPlatformMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) },
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => ({
    ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    usePathname: () => route.pathname,
    useSegments: () => route.pathname === '/' ? ['(app)'] : ['(app)', 'session', '[id]'],
    useLocalSearchParams: () => route.pathname === '/' ? {} : { id: 'uncached-session' },
}));
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown is outside cold launch'); },
}));

await initializeRealAppRuntimeForTests();

export async function expectColdHomeLaunch(
    destination: 'session' | 'home',
    connection: 'blocked' | 'reachable' | 'slow' = 'blocked',
) {
    const previousHref = window.location.href;
    route.pathname = destination === 'home' ? '/' : '/session/uncached-session';
    window.history.replaceState(null, '', route.pathname);
    vi.stubGlobal('matchMedia', (media: string) => ({
        media, matches: media === '(prefers-reduced-motion: reduce)',
        addEventListener() {}, removeEventListener() {},
    }));
    const { useLaunchCurtainState, finishLaunchCurtain } = await import('@/boot/launchCurtain');
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { AppShellPluginUiProjectionProvider } = await import('../plugins/AppShellPluginUiProjection');
    const { AppLaunchState, LaunchCurtain } = await import('./AppLaunchState');
    const { WorkspaceAppShellProvider } = await import('./WorkspaceAppShellProvider');
    const { registerWorkspaceRouteContext } = await import('./workspaceRouteContext');
    registerWorkspaceRouteContext(key => {
        if (key === './(app)/index.tsx') return import('@/app/(app)/index');
        throw new Error(`Unexpected workspace route in cold launch test: ${key}`);
    });
    const { WorkspaceDestinationBody } = await import('./WorkspaceDestinationBody');
    const { DestinationInstanceHost } = await import('./DestinationInstanceHost');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { storage } = await import('@/sync/domains/state/storage');
    const { isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { peekServerReachabilityState } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    const { isColdActiveServerRestorePending, getColdActiveServerReadiness } = await import('@/sync/runtime/orchestration/connectionManager');
    const { readHomeShownUnavailable } = await import('@/components/navigation/connectionStatus/HomeReachabilityGate');
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');

    const serverUrl = `https://cold-${connection}-${destination}.example.test`;
    const accountId = `cold-${connection}-${destination}`;
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.sig`,
        secret: Buffer.alloc(32, 7).toString('base64url'), custody: 'historical' as const };
    const target = destination === 'home' ? { kind: 'home' as const, params: {} }
        : { kind: 'session' as const, params: { id: 'uncached-session' } };
    const failedPing = createDeferred<void>();
    const accountReadStarted = createDeferred<void>();
    const accountRead = createDeferred<void>();
    const fade = createDeferred<void>();
    function CurtainProbe() {
        const state = useLaunchCurtainState();
        return React.createElement('CurtainProbe', { state });
    }
    function AdmittedDestination() {
        return React.createElement('AdmittedDestination');
    }
    function Destination() {
        const renderSession = () => <SessionDestinationBody />;
        return <>
            <AdmittedDestination />
            <DestinationInstanceHost tabId="cold" ref={target} pathname={route.pathname} focused visible
                navigation={{ push() {}, replace() {}, back() {} }}>
                <WorkspaceDestinationBody target={target} pathname={route.pathname}
                    renderSession={renderSession} renderSessionDetails={() => null} />
            </DestinationInstanceHost>
        </>;
    }
    function App({ boot }: { boot: boolean }) {
        return <>
            {boot ? <AppLaunchState testID="app-boot-loading" />
                : <AuthProvider initialCredentials={credentials}>
                    <AppShellPluginUiProjectionProvider>
                        <WorkspaceAppShellProvider><Destination /></WorkspaceAppShellProvider>
                    </AppShellPluginUiProjectionProvider>
                </AuthProvider>}
            <CurtainProbe />
            <LaunchCurtain />
        </>;
    }

    document.documentElement.classList.add('launch-planet');
    const screen = await renderScreen(<App boot />, {
        createNodeMock: element => (element.props as { testID?: string }).testID === 'launch-curtain'
            ? { animate: () => ({ finished: fade.promise, cancel() {} }) } : null,
    });
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    const retry = () => screen.findHostByTestId('home-unreachable-retry');
    const admit = () => screen.root.findAllByType(AdmittedDestination).length;
    const paint = () => act(async () => {
        for (let frame = 0; frame < 3; frame++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
    });
    const restore = await restoreServerAccountForTest({
        serverUrl, accountId, credentials, retainFailedColdRestore: true, requestOwnsReachabilityProbes: true,
        configureSocket: connection === 'blocked'
            ? socket => { socket.connect = vi.fn<typeof socket.connect>(() => socket); }
            : configureConnectedServerSocketBoundary,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (connection === 'blocked') {
                if (path === '/v1/auth/ping') failedPing.resolve();
                throw new TypeError('Failed to fetch');
            }
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/health') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') {
                return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse());
            }
            if (path === '/v2/account/settings') {
                if (connection === 'slow') {
                    accountReadStarted.resolve();
                    await accountRead.promise;
                }
                return Response.json({ content: null, version: 0 });
            }
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    try {
        expect(storage.getState().sessions['uncached-session']).toBeUndefined();
        expect(curtain()).toBe('up');
        await screen.update(<App boot={false} />);
        if (connection === 'blocked') {
            await failedPing.promise;
            await vi.waitFor(() => expect(peekServerReachabilityState(serverUrl, credentials.token))
                .toMatchObject({ phase: 'offline', reason: 'server_unreachable' }));
            await paint();
            expect(curtain(), JSON.stringify({
                retry: Boolean(retry()),
                restoring: screen.findAllByTestId('workspace-account-restoring').length > 0,
                coldPending: isColdActiveServerRestorePending(),
                readiness: getColdActiveServerReadiness(),
                unavailable: readHomeShownUnavailable(null),
                runtimeApplied: isAppliedActiveServerRuntimeAvailable(),
            })).toBe('leaving');
            expect(retry()).not.toBeNull();
            expect(admit()).toBe(0);
            expect(isAppliedActiveServerRuntimeAvailable()).toBe(false);
            await act(async () => { fade.resolve(); });
            expect(curtain()).toBe('gone');
            expect(retry()).not.toBeNull();
            return;
        }

        if (connection === 'slow') {
            await accountReadStarted.promise;
            await vi.waitFor(() => expect(peekServerReachabilityState(serverUrl, credentials.token)?.phase).toBe('online'));
            await paint();
            expect(curtain()).toBe('up');
            expect(admit()).toBe(0);
            expect(retry()).toBeNull();
            expect(readHomeShownUnavailable(null)).toBe(false);
            await act(async () => { accountRead.resolve(); });
        }
        await vi.waitFor(() => expect(admit()).toBe(1));
        expect(storage.getState().isDataReady).toBe(true);
        expect(retry()).toBeNull();
    } finally {
        accountRead.resolve();
        fade.resolve();
        await screen.unmount();
        finishLaunchCurtain();
        await restore.dispose();
        window.history.replaceState(null, '', previousHref);
        vi.unstubAllGlobals();
    }
}
