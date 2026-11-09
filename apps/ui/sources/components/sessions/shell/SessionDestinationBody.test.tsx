import * as React from 'react';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionMessagesFixture, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import type { Message } from '@happier-dev/session-core/messages';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceAppShellProvider } from '@/components/appShell/workspace/WorkspaceAppShellProvider';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { BrowserPresentationRetentionProvider } from '@/components/browser/surfaces/browserPresentationRetention';
import { storage } from '@/sync/domains/state/storageStore';
import { resetSessionSurfaceVisibilityForTests, getSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { SessionDestinationBody } from './SessionDestinationBody';
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

// Platform drawing/storage adapters, as in AtmosphereLayer's composed tests.
vi.mock('@/components/atmosphere/BackdropCanvas', async () => import('@/components/atmosphere/BackdropCanvas.web'));
vi.mock('@/components/atmosphere/WallpaperHaze', async () => import('@/components/atmosphere/WallpaperHaze.web'));
vi.mock('@/components/atmosphere/pictureStore', async () => import('@/components/atmosphere/pictureStore.web'));

// Static Session consumers capture the Socket factory during collection; install
// the canonical external boundary before those imports, then configure it below.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();

const viewport = vi.hoisted(() => ({ width: 1400, height: 900 }));

// Native SDK/navigation boundaries only; Session, hydration, pane and activation owners stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' }, useWindowDimensions: () => viewport });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/session/focused' }).module;
});
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
}));

afterEach(async () => {
    viewport.width = 1400;
    viewport.height = 900;
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

describe('SessionDestinationBody workspace activation', () => {
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
