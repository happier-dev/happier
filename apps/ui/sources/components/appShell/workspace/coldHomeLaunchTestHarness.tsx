import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, vi } from 'vitest';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createDeferred, findAllHostTestInstances, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { BrowserIrohHomeCarrier, BrowserIrohHomeCarrierRequest } from '@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrier';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const route = vi.hoisted(() => ({ pathname: '/' }));
const browserCarrierBoundary = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock('@/sync/runtime/browserIroh/homeCarrier/browserHomeCarrierRuntime', () => ({
    browserIrohHomeCarrierOwner: () => ({ acquire: browserCarrierBoundary.acquire }),
}));
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

type RefusalFixture = Readonly<{
    title: string;
    respond?: () => Response;
    retire?: 'clear' | 'replace';
    signsOut?: true;
    signOutDuringRecovery?: true;
    retryPending?: true;
    carrier?: Readonly<{
        code: 'unavailable' | 'identity_mismatch';
        held?: true;
        stalePoolEntry?: true;
        selected?: true;
    }>;
    code: string;
    action: 'retry' | 'restore' | 'update' | 'none';
    status?: number;
    guidanceUrl?: string;
}>;

export async function expectColdHomeLaunch(
    destination: 'session' | 'home',
    connection: 'blocked' | 'reachable' | 'slow' | 'dual-carrier' | RefusalFixture = 'blocked',
) {
    const previousHref = window.location.href;
    route.pathname = destination === 'home' ? '/' : '/session/uncached-session';
    window.history.replaceState(null, '', route.pathname);
    vi.stubGlobal('matchMedia', (media: string) => ({
        media, matches: media === '(prefers-reduced-motion: reduce)',
        addEventListener() {}, removeEventListener() {},
    }));
    const { useLaunchCurtainState, finishLaunchCurtain } = await import('@/boot/launchCurtain');
    const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
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
    const { readHomeShownUnavailable } = await import('@/components/navigation/connectionStatus/HomeReachabilityGate');
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');

    const scenario = typeof connection === 'string' ? connection : connection.title;
    const dualCarrier = connection === 'dual-carrier';
    const serverUrl = dualCarrier ? window.location.origin : `https://cold-${scenario}-${destination}.example.test`;
    const descriptorIdentity = 'srv_cold_' + scenario.replaceAll('-', '_');
    const accountId = `cold-${scenario}-${destination}`;
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.sig`,
        secret: Buffer.alloc(32, 7).toString('base64url'), custody: 'historical' as const };
    const target = destination === 'home' ? { kind: 'home' as const, params: {} }
        : { kind: 'session' as const, params: { id: 'uncached-session' } };
    const identityReadFailed = createDeferred<void>();
    const carrierAcquisitionStarted = createDeferred<void>();
    const carrierVerification = createDeferred<void>();
    const carrierRetryStarted = createDeferred<void>();
    const releaseBlockedRead = createDeferred<void>();
    const authenticatedRequests: string[] = [];
    const publicIdentityStarted = createDeferred<void>();
    const releasePublicIdentity = createDeferred<void>();
    if (dualCarrier) {
        expect(new URL(serverUrl).protocol).toBe('http:');
        vi.stubGlobal('SharedWorker', undefined);
    }
    const selectedIdentityRead = createDeferred<void>();
    const carrierFailure = typeof connection === 'object' ? connection.carrier : undefined;
    let keepNextReadPending = false;
    if (carrierFailure) {
        vi.stubGlobal('SharedWorker', class TestSharedWorker {});
        const { IrohError } = await import('@happier-dev/iroh-native');
        browserCarrierBoundary.acquire.mockImplementation(async (input: BrowserIrohHomeCarrierRequest) => {
            if (keepNextReadPending) {
                carrierRetryStarted.resolve();
                await carrierVerification.promise;
            }
            carrierAcquisitionStarted.resolve();
            if (carrierFailure.held) await carrierVerification.promise;

            if (!carrierFailure.selected) throw new IrohError(carrierFailure.code, carrierFailure.code);
            return {
                leaseId: 'review-selected-transport', endpointId: input.endpoint.endpointId,
                homeServerIdentityId: input.homeServerIdentityId,
                appliedRelayUrls: [],
                readObservedPath: () => 'relay',
                async request(url, init) {
                    const path = new URL(url).pathname;
                    if (path === '/v1/account/encryption/currentness') {
                        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + credentials.token);
                        selectedIdentityRead.resolve();
                        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                    }
                    if (path === '/v1/auth/ping') return Response.json({ ok: true });
                    if (path === '/v1/features' || path === '/v1/features/authenticated') {
                        return Response.json(createRootLayoutFeaturesResponse());
                    }
                    return createEmptyAccountBootstrapHttpResponse(path, init);
                },
                createWebSocket() { throw new Error('The test ends at the first identity read'); },
                release: async () => {},
            } satisfies BrowserIrohHomeCarrier;
        });
    }
    const accountReadStarted = createDeferred<void>();
    const accountRead = createDeferred<void>();
    const releaseRetiredRead = createDeferred<void>();
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
    // The live document's curtain runs once. Later fixture rows share this test document
    // and verify each card and action with the initial curtain already gone.
    const coldDocument = curtain() === 'up';
    let unmounted = false;
    const restore = await restoreServerAccountForTest({
        serverUrl, accountId, credentials, retainFailedColdRestore: true, requestOwnsReachabilityProbes: true,
        ...(carrierFailure || dualCarrier ? { prepareHome: async (home: Readonly<{ serverUrl: string }>) => {
            const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
            await adoptHomeProfile({
                source: 'manual', descriptorAuthority: 'current_connection_observation',
                descriptor: { v: 1, homeServerIdentityId: descriptorIdentity,
                    canonicalServerUrl: home.serverUrl, revision: 1,
                    endpoints: [
                        { kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/'] },
                        ...(dualCarrier ? [{ kind: 'https' as const, url: home.serverUrl }] : []),
                    ] },
            });
        } } : {}),
        configureSocket: connection === 'blocked' || typeof connection === 'object'
            ? socket => { socket.connect = vi.fn<typeof socket.connect>(() => socket); }
            : configureConnectedServerSocketBoundary,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (new Headers(init?.headers).has('Authorization')) authenticatedRequests.push(String(input));
            const identityRead = path === '/v1/account/encryption/currentness' || path === '/v1/account/encryption';
            if (connection === 'blocked') {
                if (identityRead) {
                    identityReadFailed.resolve();
                    await releaseBlockedRead.promise;
                }
                throw new TypeError('Failed to fetch');
            }
            if (typeof connection === 'object' && identityRead && (connection.respond || connection.retire || connection.retryPending)) {
                identityReadFailed.resolve();
                if (connection.retire) await releaseRetiredRead.promise;
                if (keepNextReadPending) {
                    accountReadStarted.resolve();
                    await accountRead.promise;
                }
                if (connection.respond) return connection.respond();
                throw new TypeError('Failed to fetch');
            }
            if (path === '/v1/auth/ping') {
                if (typeof connection === 'object' && connection.signOutDuringRecovery && connection.respond) {
                    return connection.respond();
                }
                return Response.json({ ok: true });
            }
            if (path === '/health') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') {
                return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                if (dualCarrier && path === '/v1/features') {
                    publicIdentityStarted.resolve();
                    await releasePublicIdentity.promise;
                }
                return Response.json(createRootLayoutFeaturesResponse(dualCarrier
                    ? { capabilities: { serverIdentity: { serverIdentityId: descriptorIdentity } } }
                    : undefined));
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
        if (coldDocument) expect(curtain()).toBe('up');
        await screen.update(<App boot={false} />);
        if (connection === 'blocked' || typeof connection === 'object') {
            if (carrierFailure) {
                await carrierAcquisitionStarted.promise;
                if (carrierFailure.selected) {
                    await paint();
                    expect(authenticatedRequests).toEqual([]);
                    carrierVerification.resolve();
                    await selectedIdentityRead.promise;
                    expect(authenticatedRequests).toEqual([]);
                    return;
                }
                if (carrierFailure.held) {
                    const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
                    const { retryActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                    const releaseStaleEntry = carrierFailure.stalePoolEntry
                        ? reachability.subscribeServerReachabilityState(serverUrl, () => {}, credentials.token)
                        : undefined;
                    window.dispatchEvent(new Event('online'));
                    await reachability.invalidateAllServerReachabilitySupervisors();
                    const retryOperation = retryActiveServerConnection().catch(() => undefined);
                    await paint();
                    expect(authenticatedRequests).toEqual([]);
                    expect(reachability.peekServerReachabilityState(serverUrl, credentials.token)?.phase ?? null)
                        .toBe(releaseStaleEntry ? 'idle' : null);
                    expect(retry()).toBeNull();
                    expect(screen.findHostByTestId('home-unreachable')).toBeNull();
                    if (coldDocument) expect(curtain()).toBe('up');
                    await screen.unmount();
                    unmounted = true;
                    releaseStaleEntry?.();
                    if (releaseStaleEntry) await reachability.stopServerReachabilitySupervisor(serverUrl, credentials.token);
                    expect(reachability.peekServerReachabilityState(serverUrl, credentials.token)).toBeNull();
                    carrierVerification.resolve();
                    await retryOperation;
                    expect(authenticatedRequests).toEqual([]);
                    expect(reachability.peekServerReachabilityState(serverUrl, credentials.token)).toBeNull();
                    return;
                }
            } else {
                await identityReadFailed.promise;
                if (connection === 'blocked') {
                    expect(authenticatedRequests.map(url => new URL(url).pathname))
                        .toEqual(['/v1/account/encryption/currentness']);
                    expect(peekServerReachabilityState(serverUrl, credentials.token)).toBeNull();
                    expect(screen.findHostByTestId('home-unreachable')).toBeNull();
                    await act(async () => { releaseBlockedRead.resolve(); });
                }
                if (typeof connection === 'object' && connection.retire) {
                    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
                    await act(async () => {
                        if (connection.retire === 'clear') {
                            expect(await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId: restore.serverId })).toBe(true);
                        } else {
                            const replacementToken = credentials.token.replace(/\.sig$/, '.replacement');
                            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: restore.serverId },
                                { ...credentials, token: replacementToken })).toBe(true);
                        }
                        // The selected replacement starts its own admission after this restore settles.
                        // See the retired attempt's verdict while its deferred read is still in flight.
                        if (connection.retire === 'clear') releaseRetiredRead.resolve();
                    });
                }
            }
            await paint();
            if (coldDocument) expect(curtain()).toBe('leaving');
            if (connection === 'blocked') {
                expect(retry()).not.toBeNull();
            } else {
                if (carrierFailure) {
                    expect(authenticatedRequests).toEqual([]);
                    expect(peekServerReachabilityState(serverUrl, credentials.token)).toBeNull();
                }
                const code = connection.code;
                expect(Boolean(retry())).toBe(connection.action === 'retry');
                const { t } = await import('@/text');
                const detailsName = t('approvals.technicalDetails');
                const details = await vi.waitFor(() => {
                    const [toggle] = findAllHostTestInstances(screen.root, node =>
                        (node.props.role ?? node.props.accessibilityRole) === 'button'
                        && (node.props['aria-label'] ?? node.props.accessibilityLabel) === detailsName);
                    expect(toggle, 'Recovery card must expose its Technical details button').toBeDefined();
                    return toggle!;
                });
                await pressTestInstanceAsync(details, detailsName);
                expect(screen.getTextContent()).toContain(code);
                for (const action of ['restore', 'update'] as const) {
                    expect(Boolean(screen.findHostByTestId(`home-admission-${action}`))).toBe(connection.action === action);
                }
                if (connection.guidanceUrl) {
                    const open = vi.fn();
                    vi.stubGlobal('open', open);
                    await pressTestInstanceAsync(screen.findHostByTestId('home-admission-update')!);
                    expect(open).toHaveBeenCalledWith(connection.guidanceUrl, '_blank', 'noopener,noreferrer');
                }
                if (connection.status) expect(screen.getTextContent()).toContain(`HTTP ${connection.status}`);
                if (connection.retryPending) {
                    keepNextReadPending = true;
                    void retry()?.props.onPress();
                    await (carrierFailure ? carrierRetryStarted.promise : accountReadStarted.promise);
                    await paint();
                    expect(retry()).not.toBeNull();
                    expect(screen.getTextContent()).toContain(code);
                    expect(screen.findHostByTestId('workspace-account-restoring')).toBeNull();
                    if (carrierFailure) expect(authenticatedRequests).toEqual([]);
                    carrierVerification.resolve();
                    accountRead.resolve();
                }
                if (connection.signOutDuringRecovery) {
                    const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
                    await vi.waitFor(() => expect(peekServerReachabilityState(serverUrl, credentials.token)?.phase).toBe('offline'));
                    await act(async () => { expect(await getCurrentAuth()?.logout()).toEqual({ kind: 'completed' }); });
                    expect(getCurrentAuth()?.isAuthenticated).toBe(false);
                    expect(isAppliedActiveServerRuntimeAvailable()).toBe(true);
                    expect(peekServerReachabilityState(serverUrl, credentials.token)).toBeNull();
                    const requestsAfterLogout = authenticatedRequests.length;
                    window.dispatchEvent(new Event('online'));
                    await reachability.invalidateAllServerReachabilitySupervisors();
                    await paint();
                    expect(authenticatedRequests).toHaveLength(requestsAfterLogout);
                    return;
                }
            }
            expect(admit()).toBe(0);
            const signsOut = typeof connection === 'object' && connection.signsOut;
            if (signsOut) {
                await vi.waitFor(() => expect(getCurrentAuth()?.isAuthenticated).toBe(false));
            } else {
                expect(isAppliedActiveServerRuntimeAvailable()).toBe(false);
            }
            await act(async () => { fade.resolve(); });
            expect(curtain()).toBe('gone');
            if (connection === 'blocked') expect(retry()).not.toBeNull();
            if (signsOut) {
                expect(admit()).toBe(0);
                expect(screen.findHostByTestId('home-admission-restore')).not.toBeNull();
                expect(retry()).toBeNull();
            }
            return;
        }

        if (dualCarrier) {
            await publicIdentityStarted.promise;
            await paint();
            const reachability = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            window.dispatchEvent(new Event('online'));
            await reachability.invalidateAllServerReachabilitySupervisors();
            expect(authenticatedRequests).toEqual([]);
            expect(reachability.peekServerReachabilityState(serverUrl, credentials.token)).toBeNull();
            expect(screen.findHostByTestId('home-unreachable')).toBeNull();
            expect(admit()).toBe(0);
            await act(async () => { releasePublicIdentity.resolve(); });
        }
        if (connection === 'slow') {
            await accountReadStarted.promise;
            await paint();
            expect(curtain()).toBe('up');
            expect(admit()).toBe(0);
            expect(retry()).toBeNull();
            expect(readHomeShownUnavailable(null)).toBe(false);
            expect(screen.findAllByTestId('workspace-account-restoring')).not.toHaveLength(0);
            await act(async () => { accountRead.resolve(); });
        }
        await vi.waitFor(() => expect(admit()).toBe(1), { timeout: 5000 });
        if (dualCarrier) {
            expect(browserCarrierBoundary.acquire).not.toHaveBeenCalled();
            expect(authenticatedRequests.some(url => new URL(url).pathname === '/v1/auth/ping')).toBe(true);
            expect(authenticatedRequests.some(url => new URL(url).pathname === '/v1/account/encryption/currentness')).toBe(true);
            expect(authenticatedRequests.every(url => new URL(url).origin === serverUrl)).toBe(true);
            expect(screen.findHostByTestId('home-unreachable')).toBeNull();
        }
        expect(storage.getState().isDataReady).toBe(true);
        expect(retry()).toBeNull();
    } finally {
        accountRead.resolve();
        releaseRetiredRead.resolve();
        releaseBlockedRead.resolve();
        releasePublicIdentity.resolve();
        carrierVerification.resolve();
        fade.resolve();
        browserCarrierBoundary.acquire.mockReset();
        if (!unmounted) await screen.unmount();
        finishLaunchCurtain();
        await restore.dispose();
        window.history.replaceState(null, '', previousHref);
        vi.unstubAllGlobals();
    }
}
