import * as React from 'react';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, createSessionMessagesFixture, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import type { Message } from '@happier-dev/session-core/messages';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { DestinationInstanceHost, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceAppShellProvider } from '@/components/appShell/workspace/WorkspaceAppShellProvider';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { BrowserPresentationRetentionProvider } from '@/components/browser/surfaces/browserPresentationRetention';
import { readHomeShownUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { storage } from '@/sync/domains/state/storageStore';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resetSessionSurfaceVisibilityForTests, getSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { SessionDestinationBody } from './SessionDestinationBody';
import SessionDetailsRouteEntry from '@/app/(app)/session/[id]/details';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createPlainAccountEncryptionCurrentnessHttpResponse } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { SessionView } from './SessionView';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import '@/sync/syncEngine';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { ComputerScreenViewer } from '@/components/computer/ComputerScreenViewer';
import { AgentInput } from '@/components/sessions/agentInput';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { AtmosphereLayer } from '@/components/atmosphere/AtmosphereLayer';
import { atmosphereStageStore } from '@/components/atmosphere/atmosphereStage';
import { pictureStore } from '@/components/atmosphere/pictureStore';
import type { BackdropWorkerRequest, BackdropWorkerResponse } from '@/components/atmosphere/backdropCanvas.types';
import { GlassRuntimeEnvironmentProvider, GlassAtmosphereBehindSetterProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import type { GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { hrefForDestinationRef, resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceEmptyTab, createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { detailsTabPanelNativeId } from '@/components/appShell/panes/details/workspace/DetailsTabStrip';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { t } from '@/text';

// Platform drawing/storage adapters, as in AtmosphereLayer's composed tests.
vi.mock('@/components/atmosphere/BackdropCanvas', async () => import('@/components/atmosphere/BackdropCanvas.web'));
vi.mock('@/components/atmosphere/WallpaperHaze', async () => import('@/components/atmosphere/WallpaperHaze.web'));
vi.mock('@/components/atmosphere/pictureStore', async () => import('@/components/atmosphere/pictureStore.web'));

// Static Session consumers capture the Socket factory during collection; install
// the canonical external boundary before those imports, then configure it below.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();

const viewport = vi.hoisted(() => ({ width: 1400, height: 900, followNavigation: false }));
const expoLocation = vi.hoisted(() => ({
    pathname: '/session/focused', params: {} as Record<string, string>,
    replace: (_href: unknown) => {},
}));

// Native SDK/navigation boundaries only; Session, hydration, pane and activation owners stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' }, useWindowDimensions: () => viewport });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => expoLocation.pathname, params: () => expoLocation.params,
        router: { replace: href => expoLocation.replace(href) } }).module;
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    const sdk = createReactNavigationNativeMock({ renderInitialNavigatorScreen: true });
    type TabNavigation = Readonly<{
        navigate: (name: string) => void;
        canGoBack: () => boolean;
        goBack: () => void;
        emit: () => { defaultPrevented: boolean };
    }>;
    type TabBarInput = Readonly<{
        state: { index: number; routes: { name: string; key: string }[] };
        navigation: TabNavigation;
    }>;
    function RoutedNavigator({ children, initialRouteName, tabBar }: React.PropsWithChildren<{
        initialRouteName?: string;
        tabBar?: (input: TabBarInput) => React.ReactNode;
    }>) {
        const screens = React.Children.toArray(children).filter(React.isValidElement<{
            name: string;
            children: (input: { navigation: TabNavigation }) => React.ReactNode;
        }>);
        const routes = screens.map(screen => ({ name: screen.props.name, key: screen.props.name }));
        const [active, setActive] = React.useState(initialRouteName);
        const index = Math.max(0, routes.findIndex(route => route.name === active));
        const navigation = { navigate: setActive, canGoBack: () => false, goBack: () => {}, emit: () => ({ defaultPrevented: false }) };
        return <><React.Fragment key={routes[index].key}>{screens[index].props.children({ navigation })}</React.Fragment>
            {tabBar?.({ state: { index, routes }, navigation })}</>;
    }
    return { ...sdk, createNavigatorFactory: (navigator: unknown) => () => {
        const initial = sdk.createNavigatorFactory(navigator)();
        return { ...initial, Navigator: (props: React.ComponentProps<typeof RoutedNavigator>) =>
            viewport.followNavigation ? <RoutedNavigator {...props} /> : <initial.Navigator {...props} /> };
    } };
});
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
}));

afterEach(async () => {
    viewport.width = 1400;
    viewport.height = 900;
    viewport.followNavigation = false;
    expoLocation.pathname = '/session/focused';
    expoLocation.params = {};
    expoLocation.replace = () => {};
    await standardCleanup();
});
const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-shell' })).toString('base64url')}.signature` };

async function withSessionFixture(run: (serverId: string) => Promise<void>,
    request?: Parameters<typeof restoreServerAccountForTest>[0]['request']) {
    await prepareSessionDraftPersistenceStorage();
    await loadSyncSingletonForTests();
    const previousState = storage.getState();
    // Bind the real Account/Sync lifecycle while the canonical HTTP and Socket
    // adapters own an unavailable fixture Home. No hydration or admission owner is mocked.
    const account = await restoreServerAccountForTest({
        serverUrl: 'https://shell-test.example', credentials,
        request: request ?? (async () => Response.json({ error: 'fixture_home_offline' }, { status: 503 })),
    });
    const serverId = account.home.id;
    const frameGlobals = ['requestAnimationFrame', 'cancelAnimationFrame'] as const;
    const previousFrameGlobals = frameGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    resetSessionSurfaceVisibilityForTests();
    storage.getState().applyMachines([createMachineFixture({ activeAt: Date.now() })]);
    storage.getState().applySessions(['focused', 'companion'].map((id) => createSessionFixture({ id, serverId, active: true })));
    storage.setState({ settings: { ...storage.getState().settings, mobileWorkspaceExperienceV1: 'classic' } });
    storage.setState({ settingsScope: { serverId, accountId: 'account-shell' }, profileScope: { serverId, accountId: 'account-shell' } });
    try {
        installShippedNativeFrameScheduler();
        await run(serverId);
    } finally {
        try {
            await standardCleanup();
        } finally {
            await account.dispose();
            storage.setState(previousState);
            resetSessionSurfaceVisibilityForTests();
            for (const [key, descriptor] of previousFrameGlobals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    }
}

// A retained destination must use a tab admitted by the real workspace owner. An
// invented tab id is interpreted as a removed destination when its viewer portals.
function WorkspaceSessionDestination(props: Readonly<{ id: string; serverId: string }>) {
    const workspace = useOptionalWorkspaceNavigation();
    const tabId = workspace?.state.groups[workspace.state.focusedGroupId]?.activeTabId;
    if (!tabId || !workspace?.state.tabs[tabId]) throw new Error('Expected an admitted workspace tab');
    return <DestinationInstanceHost tabId={tabId} ref={{ kind: 'session', params: props }}
        pathname={`/session/${props.id}`} focused visible navigation={workspace.navigationForTab(tabId)}>
        <SessionDestinationBody />
    </DestinationInstanceHost>;
}

describe('bare Session Details address', () => {
    it('docks Details when the first cold document after sign-in hydrates an unqualified Session', async () => {
        viewport.width = 1440;
        viewport.followNavigation = true;
        const id = 'after-sign-in-details';
        const parentPath = `/session/${id}`;
        const href = `${parentPath}/details`;
        const location = new URL(`https://shell.test${href}`);
        const history = {
            state: null as unknown,
            replaceState(state: unknown, _unused: string, url?: string | URL | null) {
                history.state = state;
                if (url) location.href = new URL(url, location.href).href;
            },
            pushState(state: unknown, unused: string, url?: string | URL | null) {
                history.replaceState(state, unused, url);
            },
            go() {},
        };
        expoLocation.pathname = href;
        expoLocation.params = { id };
        expoLocation.replace = next => {
            if (typeof next !== 'string') throw new Error('Expected a Session pathname');
            history.replaceState(history.state, '', next);
        };
        vi.stubGlobal('window', Object.assign(new EventTarget(), { history, location,
            sessionStorage: { getItem: () => 'details-sign-in' } }));

        const requestRouteReplacement = vi.fn();
        function ActiveWorkspace() {
            const workspace = useOptionalWorkspaceNavigation();
            if (!workspace?.active) return null;
            const group = workspace.state.groups[workspace.state.focusedGroupId];
            const tab = workspace.state.tabs[group.activeTabId];
            if (tab.target.kind !== 'session') return null;
            // Hold the navigation acknowledgement. The export displayed the
            // admitted bare destination after the exact Session read had settled.
            return <DestinationInstanceHost tabId={tab.id} ref={tab.target}
                pathname={tab.target.params.workspacePathname ?? parentPath} focused visible
                navigation={{ ...workspace.navigationForTab(tab.id), replace: requestRouteReplacement }}>
                <SessionDestinationBody />
            </DestinationInstanceHost>;
        }

        const releaseRead = createDeferred<void>();
        const boundary = createSessionReadBatchHttpBoundary(async ({ path }) => {
            if (!path.endsWith(`/${id}`)) return undefined;
            await releaseRead.promise;
            return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id })));
        });
        try {
            await withSessionFixture(async serverId => {
                // Sign-in saved credentials. The next document starts at Details with an
                // empty ordinary list; the exact route read supplies the first Session.
                storage.setState({ isDataReady: false });
                const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                    <AppPaneProvider><WorkspaceAppShellProvider>
                        <SessionDetailsRouteEntry />
                        <ActiveWorkspace />
                    </WorkspaceAppShellProvider></AppPaneProvider>
                </InjectedAuthProvider>);
                try {
                    expect(screen.findAllByType(SessionView)).toHaveLength(0);
                    await act(async () => { storage.setState({ isDataReady: true }); });
                    await vi.waitFor(() => {
                        expect(boundary.componentRequests.some(request => request.path.endsWith(`/${id}`))).toBe(true);
                    });
                    expect(screen.findAllByType(SessionView)).toHaveLength(0);
                    await act(async () => { releaseRead.resolve(); });
                    await vi.waitFor(() => {
                        const view = screen.findAllByType(SessionView)[0];
                        expect(view?.props.routeHydrationState).toMatchObject({ kind: 'available', serverId });
                        expect(view?.props.routeServerId).toBeUndefined();
                    });
                    const details = screen.findHostByTestId('multi-pane-details-docked');
                    expect({ pathname: location.pathname, docked: details !== null }).toEqual({ pathname: href, docked: true });
                    const selected = details!.findAll(node => typeof node.type === 'string'
                        && node.props.accessibilityRole === 'tab' && node.props.accessibilityState?.selected);
                    expect(selected.map(tab => tab.props.accessibilityLabel))
                        .toEqual([t('session.detailsPanel.openTabA11y', { title: t('files.toolbar.review') })]);
                } finally {
                    releaseRead.resolve();
                    await screen.unmount();
                }
            }, async (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input));
                return await boundary.handle({
                    home: 'shell-test', accountId: 'account-shell', url, path: url.pathname,
                    method: init?.method ?? 'GET', headers: new Headers(init?.headers),
                    body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal,
                }) ?? createPlainAccountEncryptionCurrentnessHttpResponse(url.pathname)
                    ?? createEmptyAccountBootstrapHttpResponse(url.pathname, init);
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each([1440, 390])('opens the Details pane with a selected tab on a cold %ipx visit and keeps the warm selection', async width => {
        viewport.width = width;
        viewport.followNavigation = true;
        const phone = width === 390;
        await withSessionFixture(async serverId => {
            storage.setState({ isDataReady: true, settings: {
                ...storage.getState().settings, mobileWorkspaceExperienceV1: 'cockpit',
            } });
            const sessionId = 'focused';
            const rootHref = `/session/${sessionId}?serverId=${serverId}`;
            const detailsHref = `/session/${sessionId}/details?serverId=${serverId}`;
            const catalog = resolveCompactAppDestinations({
                builtins: { externalSessions: false, inbox: false, workflows: false, friends: false },
                pages: [],
            });
            const createNavigation = (entryHref: string, visit: 'cold' | 'warm') => {
                const prefix = `details-${visit}-${width}`;
                let state = createWorkspaceState(createWorkspaceEmptyTab(prefix));
                let nextTab = 0;
                const listeners = new Set<() => void>();
                const navigation = createWorkspaceNavigationAdapter({
                    getState: () => state,
                    getCatalog: () => catalog,
                    dispatch: action => { state = reduceWorkspaceState(state, action); },
                    createId: () => `${prefix}-${++nextTab}`,
                    transport: { commit: () => {} },
                    onChange: () => { for (const listener of listeners) listener(); },
                });
                navigation.initialize(entryHref);
                return {
                    navigation,
                    active: () => state.tabs[state.groups[state.focusedGroupId].activeTabId],
                    subscribe: (listener: () => void) => {
                        listeners.add(listener);
                        return () => { listeners.delete(listener); };
                    },
                };
            };
            let pane: ReturnType<typeof useAppPaneScope> | undefined;
            function RetainedPaneCommands() {
                const instanceKey = useDestinationInstanceKey();
                pane = useAppPaneScope(createSessionPaneScopeId(sessionId, serverId, instanceKey));
                return null;
            }
            function Destination({ workspace }: Readonly<{ workspace: ReturnType<typeof createNavigation> }>) {
                const tab = React.useSyncExternalStore(workspace.subscribe, workspace.active);
                const href = hrefForDestinationRef(catalog, tab.target);
                if (!href) throw new Error('Expected a routable Session destination');
                return <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                    <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={href.split('?')[0]}
                        focused visible phone={phone} navigation={{ push: () => {}, replace: () => {}, back: () => {},
                            setParams: params => workspace.navigation.setParams(tab.id, params) }}>
                        <RetainedPaneCommands />
                        <SessionDestinationBody />
                    </DestinationInstanceHost>
                </AppPaneProvider></InjectedAuthProvider>;
            }
            const assertSelected = (screen: Awaited<ReturnType<typeof renderScreen>>, title: string) => {
                const containerId = phone ? 'session-details-screen' : 'multi-pane-details-docked';
                const details = screen.findHostByTestId(containerId);
                expect(details, containerId).not.toBeNull();
                const tabs = details!.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'tab');
                expect(tabs.filter(node => node.props.accessibilityState?.selected).map(node => node.props.accessibilityLabel))
                    .toEqual([t('session.detailsPanel.openTabA11y', { title })]);
            };
            const cold = createNavigation(detailsHref, 'cold');
            const coldScreen = await renderScreen(<Destination workspace={cold} />);
            try {
                await vi.waitFor(() => assertSelected(coldScreen, t('files.toolbar.review')));
                expect(hrefForDestinationRef(catalog, cold.active().target)).toBe(detailsHref);
            } finally {
                await coldScreen.unmount();
            }

            const warm = createNavigation(rootHref, 'warm');
            const retainedId = warm.active().id;
            const warmScreen = await renderScreen(<Destination workspace={warm} />);
            await act(async () => {
                pane!.openDetailsTab(createWorkspaceFileDetailsTab('first.txt'), { intent: 'pinned', present: false });
                pane!.openDetailsTab(createWorkspaceFileDetailsTab('retained.txt'), { intent: 'pinned', present: false });
                pane!.closeDetails();
            });
            expect(pane?.scopeState?.details.isOpen).toBe(false);
            await act(async () => { expect(warm.navigation.acceptUrl(detailsHref)).toBe(true); });
            expect(warm.active().id).toBe(retainedId);
            await vi.waitFor(() => {
                const state = pane?.scopeState?.details;
                expect(state?.isOpen).toBe(true);
                const selected = state?.tabs.find(tab => tab.key === state.activeTabKey);
                expect(selected?.title).toBe('retained.txt');
                const panelId = detailsTabPanelNativeId(state!.focusedGroupId!, selected!.key);
                const container = warmScreen.findHostByTestId(phone ? 'session-details-screen' : 'multi-pane-details-docked');
                // The phone puts the retained file's tab controls in its own header.
                const visiblePanels = container?.findAll(node => typeof node.type === 'string'
                    && node.props.role === 'tabpanel' && node.props.pointerEvents === 'auto');
                expect(visiblePanels?.map(panel => panel.props.nativeID)).toEqual([panelId]);
            });
            await act(async () => { expect(warm.navigation.acceptUrl(rootHref)).toBe(true); });
            expect(warm.active().id).toBe(retainedId);
            expect(hrefForDestinationRef(catalog, warm.active().target)?.split('?')[0]).toBe(`/session/${sessionId}`);
        });
    });
});

describe('SessionDestinationBody workspace activation', () => {
    it('keeps a cold Session curtain until the body draws, and leaves a later Session load in the shell', async () => {
        const cold = createDeferred<void>();
        const warm = createDeferred<void>();
        let coldReadStarted = false;
        const boundary = createSessionReadBatchHttpBoundary(async ({ path }) => {
            const id = path.split('/').at(-1);
            if (id !== 'cold-curtain-session' && id !== 'warm-curtain-session') return undefined;
            if (id === 'cold-curtain-session') coldReadStarted = true;
            await (id === 'cold-curtain-session' ? cold.promise : warm.promise);
            return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id })));
        });
        await withSessionFixture(async serverId => {
            const launch = startTestLaunchCurtain();
            publishAppliedActiveServerRuntimeAvailability(true);
            storage.setState({ endpointStatus: 'online', endpointReason: null, socketStatus: 'connected', syncError: null });
            const tree = (id: string) => <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                <DestinationInstanceHost key={id} tabId={id} ref={{ kind: 'session', params: { id, serverId } }}
                    pathname={`/session/${id}`} focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>
                <CurtainProbe />
            </AppPaneProvider></InjectedAuthProvider>;
            const screen = await renderScreen(tree('cold-curtain-session'));
            const curtain = () => screen.root.findByType('CurtainProbe').props.state;
            try {
                await vi.waitFor(() => expect(coldReadStarted).toBe(true));
                expect(readHomeShownUnavailable(serverId)).toBe(false);
                expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
                launch.releaseShell();
                await launch.paint();
                expect(curtain()).toBe('up');
                await act(async () => { cold.resolve(); });
                await vi.waitFor(() => expect(screen.findAllByType(SessionView)).toHaveLength(1));
                await launch.paint();
                expect(curtain()).toBe('leaving');
                await act(async () => { launch.finish(); });
                await screen.update(tree('warm-curtain-session'));
                expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
                await launch.paint();
                expect(curtain()).toBe('gone');
            } finally {
                cold.resolve();
                warm.resolve();
                await screen.unmount();
                launch.dispose();
            }
        }, async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname !== '/v2/sessions/read-batch' && !url.pathname.endsWith('-curtain-session')) {
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                return createPlainAccountEncryptionCurrentnessHttpResponse(url.pathname)
                    ?? createEmptyAccountBootstrapHttpResponse(url.pathname, init);
            }
            return await boundary.handle({
                home: 'shell-test', accountId: 'account-shell', url, path: url.pathname,
                method: init?.method ?? 'GET', headers: new Headers(init?.headers),
                body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal,
            }) ?? null;
        });
    });

    it('keeps Home pictures hidden while cold Session data and Project membership are unknown', async () => {
        let release: (() => void) | undefined;
        let sessionReads = 0;
        let paints = 0;
        const localId = 'cold-session-atmosphere';
        vi.stubGlobal('Worker', class {
            onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
            postMessage(message: BackdropWorkerRequest) {
                if (!('request' in message)) return;
                const { width: w, height: h } = message.request;
                queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                    result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
            }
            terminate() {}
        });
        vi.stubGlobal('ImageData', class {
            constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
        });
        try {
            await pictureStore.put({ localId, kind: 'user', data: new Blob(['cached prepared picture']) });
            await withSessionFixture(async serverId => {
                storage.setState({ isDataReady: true, settings: { ...storage.getState().settings,
                    homeAtmosphere: { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', showOn: ['sessions'],
                        picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' } },
                } });
                function Shell() {
                    const [atmosphereBehind, setBehind] = React.useState<GlassMaterialEnvironment['atmosphereBehind']>('none');
                    return <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                        <GlassAtmosphereBehindSetterProvider value={setBehind}>
                            <AtmosphereLayer sheetRadius={12} chrome={false} />
                            <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                                <DestinationInstanceHost tabId="cold" ref={{ kind: 'session', params: { id: 'cold-atmosphere', serverId } }}
                                    pathname="/session/cold-atmosphere" focused visible
                                    navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                                    <SessionDestinationBody />
                                </DestinationInstanceHost>
                            </AppPaneProvider></InjectedAuthProvider>
                        </GlassAtmosphereBehindSetterProvider>
                    </GlassRuntimeEnvironmentProvider>;
                }
                const screen = await renderScreen(<Shell />, { createNodeMock: element => element.type === 'canvas'
                    ? { getContext: () => ({ putImageData() { paints++; } }) }
                    : { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 80, 60) },
                });
                try {
                    await vi.waitFor(() => expect(sessionReads).toBe(1));
                    expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
                    expect(storage.getState().sessions['cold-atmosphere']).toBeUndefined();
                    expect(screen.findAllByType(SessionView)).toHaveLength(0);
                    // docs/surface-states.md: panes inherit the shell coat; unknown
                    // membership must still never use Home's picture as a placeholder.
                    expect(atmosphereStageStore.get().pictureShown).toBe(false);
                    expect(paints).toBe(0);
                    expect(sessionReads).toBe(1);
                } finally {
                    await screen.unmount();
                    release?.();
                }
            }, async (input, init) => {
                const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
                if (path === '/v2/sessions/read-batch' && String(init?.body).includes('cold-atmosphere')) {
                    sessionReads++;
                    await new Promise<void>(resolve => { release = resolve; });
                }
                return Response.json({ error: 'fixture_home_offline' }, { status: 503 });
            });
        } finally {
            release?.();
            await pictureStore.remove(localId);
            vi.unstubAllGlobals();
        }
    });

    it('keeps Session content, list, draft and the open Computer viewer across breakpoints and resets for another Session', async () => {
        await withSessionFixture(async serverId => {
            storage.setState({ isDataReady: true, settings: { ...storage.getState().settings,
                mobileWorkspaceExperienceV1: 'cockpit', transcriptGroupingMode: 'linear',
            },
                // Computer lives in the header menu when the optional action rail is hidden.
                localSettings: { ...storage.getState().localSettings, uiMultiPanePanelsEnabled: false },
            });
            const messages: Message[] = Array.from({ length: 24 }, (_, index) => ({
                kind: 'user-text', id: `message-${index}`, seq: index + 1, localId: null,
                createdAt: index + 1, text: `Discuss the next change ${index + 1}.`,
            }));
            storage.setState({ sessionMessages: { ...storage.getState().sessionMessages,
                focused: createSessionMessagesFixture({
                    messageIdsOldestFirst: messages.map(message => message.id),
                    messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
                    isLoaded: true,
                }),
            } });
            const body = (id = 'focused') => <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                <WorkspaceAppShellProvider>
                <BrowserPresentationRetentionProvider>
                <WorkspaceSessionDestination id={id} serverId={serverId} />
                </BrowserPresentationRetentionProvider>
                </WorkspaceAppShellProvider>
            </AppPaneProvider></InjectedAuthProvider>;
            const screen = await renderScreen(body());
            const loadedContent = () => screen.tree.findAll(node => (
                typeof node.type === 'function' && node.type.name === 'SessionViewLoadedContent'
            ));
            expect(loadedContent()).toHaveLength(1);
            const content = loadedContent()[0];
            const list = screen.findAllByType(LegendList)[0];
            expect(list).toBeDefined();
            const listRef: React.RefObject<LegendListRef | null> = list.props.ref;
            expect(listRef.current).not.toBeNull();
            // Deliver the scroll observation at Legend's native/DOM scroller
            // boundary; its real virtualization and transcript owners run below it.
            const scroller = list.findAll(node => node.props.refScrollView && typeof node.props.onScroll === 'function')[0];
            expect(scroller).toBeDefined();
            await act(async () => {
                invokeTestInstanceHandler(scroller, 'onScroll', {
                    nativeEvent: {
                        contentOffset: { x: 0, y: 480 },
                        contentSize: { width: 1000, height: 3000 },
                        layoutMeasurement: { width: 1000, height: 600 },
                    },
                });
                screen.findAllByType(AgentInput)[0].props.onChangeText('Keep this draft while resizing');
            });
            expect(listRef.current?.getState().scroll).toBe(480);
            expect(screen.findAllByType(AgentInput)[0].props.value.getPrompt()).toBe('Keep this draft while resizing');
            const assertContentRetained = () => {
                expect(loadedContent()).toHaveLength(1);
                expect(loadedContent()[0]).toBe(content);
                expect(screen.findAllByType(LegendList)[0]).toBe(list);
                expect(screen.findAllByType(LegendList)[0].props.ref).toBe(listRef);
                expect(listRef.current?.getState().scroll).toBe(480);
                expect(screen.findAllByType(AgentInput)[0].props.value.getPrompt()).toBe('Keep this draft while resizing');
            };
            const computerMenu = screen.findAllByType(DropdownMenu).find(menu =>
                menu.props.items.some((item: Readonly<{ id: string }>) => item.id === 'header.openComputer'));
            expect(computerMenu).toBeDefined();
            expect(computerMenu!.props.items.find((item: Readonly<{ id: string }>) => item.id === 'header.openComputer'))
                .toMatchObject({ disabled: false });
            // Exercise the real header menu Action; portal geometry is outside this continuity journey.
            await act(async () => { computerMenu!.props.onSelect('header.openComputer'); });
            // The local Action actually opened the viewer before the responsive shell is replaced.
            expect(screen.findHostByTestId('session-viewer-host')).not.toBeNull();
            await act(async () => {
                invokeTestInstanceHandler(screen.findHostByTestId('session-viewer-host')!, 'onLayout', {
                    nativeEvent: { layout: { x: 0, y: 0, width: 1400, height: 900 } },
                });
            });
            // The unavailable HTTP boundary can legitimately replace an empty card with recovery.
            // Continuity belongs to the retained viewer, independently of its current status card.
            const computerBody = screen.findAllByType(ComputerScreenViewer)[0];
            expect(computerBody).toBeDefined();
            const sourceLifetime = screen.findAllByType(SessionViewerSourceAccountScopeProvider)
                .map(provider => provider.props.accountLifetime).find(lifetime => lifetime?.isCurrent());
            expect(sourceLifetime?.isCurrent()).toBe(true);
            viewport.width = 390;
            viewport.height = 844;
            await screen.update(body());
            assertContentRetained();
            // A picker opened by the old shell still borrows this exact viewing authority.
            expect(sourceLifetime?.isCurrent()).toBe(true);
            await vi.waitFor(() => expect(screen.findHostByTestId('session-viewer-sticky')).not.toBeNull());
            expect(screen.findAllByType(ComputerScreenViewer)[0]).toBe(computerBody);
            viewport.width = 1400;
            viewport.height = 900;
            await screen.update(body());
            assertContentRetained();
            expect(screen.findHostByTestId('session-viewer-host')).not.toBeNull();
            expect(screen.findAllByType(ComputerScreenViewer)[0]).toBe(computerBody);
            await screen.update(body('companion'));
            expect(sourceLifetime?.isCurrent()).toBe(false);
            expect(screen.findHostByTestId('session-viewer-host')).toBeNull();
            viewport.width = 390;
            viewport.height = 844;
            await screen.update(body('companion'));
            expect(screen.findHostByTestId('session-viewer-sticky')).toBeNull();
        });
    });

    it('renders a workspace Session tab as the Session alone, with no tab strip of its own', async () => {
        await withSessionFixture(async serverId => {
            storage.setState({ isDataReady: true });
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                {['focused', 'companion'].map(id => <DestinationInstanceHost key={id} tabId={id}
                    ref={{ kind: 'session', params: { id, serverId } }} pathname={`/session/${id}`}
                    focused={id === 'focused'} visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>)}
            </AppPaneProvider></InjectedAuthProvider>);
            // The window's title bar is the only tab rail; a split is the workspace's, never a nested canvas.
            expect(screen.tree.findAll(node => typeof node.type === 'string'
                && (node.props.accessibilityRole === 'tablist' || node.props.role === 'tablist'))).toEqual([]);
            expect(screen.findAllHostsByTestId('split-canvas-host')).toEqual([]);
            expect(screen.findHostByTestId('session-view-retained-surface:focused')).not.toBeNull();
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).not.toBeNull();
        });
    });

    it('presents both visible panes while only the focused pane owns the route anchor across retention', async () => {
        await withSessionFixture(async (serverId) => {
            const body = (companionVisible: boolean, focusedId = 'focused') => <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                {['focused', 'companion'].map((id) => <DestinationInstanceHost key={id} tabId={id}
                    ref={{ kind: 'session', params: { id, serverId } }} pathname={`/session/${id}`}
                    focused={id === focusedId} visible={id === 'focused' || companionVisible}
                    navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>)}
            </AppPaneProvider></InjectedAuthProvider>;
            const screen = await renderScreen(body(true));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused', 'companion'],
            });
            const companionSurface = screen.findHostByTestId('session-view-retained-surface:companion');
            expect(companionSurface?.props.pointerEvents).toBe('auto');
            expect(companionSurface?.props['aria-hidden']).toBe(false);
            await screen.update(body(false));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).toBe(companionSurface);
            expect(companionSurface?.props.pointerEvents).toBe('none');
            expect(companionSurface?.props['aria-hidden']).toBe(true);
            await screen.update(body(true));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused', 'companion'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).toBe(companionSurface);
            expect(companionSurface?.props.pointerEvents).toBe('auto');
            await screen.update(body(true, 'companion'));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'companion', routeAnchorSessionId: 'companion', visibleSessionIds: ['focused', 'companion'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props.pointerEvents).toBe('auto');
            await screen.update(body(true));
            await screen.update(body(false, 'companion'));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: null, routeAnchorSessionId: null, visibleSessionIds: ['focused'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props.pointerEvents).toBe('auto');
        });
    });

    it('keeps the ordinary route presented before global data readiness without a host override', async () => {
        await withSessionFixture(async (serverId) => {
            storage.setState({ isDataReady: false });
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                <SessionView id="focused" routeServerId={serverId} />
            </AppPaneProvider></InjectedAuthProvider>);
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props).toMatchObject({
                pointerEvents: 'auto', 'aria-hidden': false, inert: false,
            });
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused'],
            });
        });
    });
});
