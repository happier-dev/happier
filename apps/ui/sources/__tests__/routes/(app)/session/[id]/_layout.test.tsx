import * as React from 'react';
import { act } from 'react-test-renderer';
import { BaseNavigationContainer, createNavigatorFactory, StackRouter, useNavigationBuilder } from '@react-navigation/core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Href } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resetSessionListPaneRetentionForTests, retainSessionListPaneState } from '@/components/sessions/shell/sessionListPaneRetention';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionRouteHomesFixture, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

installSessionRouteCommonModuleMocks({
    text: async () => vi.importActual('@/text'),
    modal: async () => vi.importActual('@/modal'),
    nativeNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        const core = await vi.importActual<typeof import('@react-navigation/core')>('@react-navigation/core');
        return { ...createReactNavigationNativeMock(), useRoute: core.useRoute, useNavigationState: core.useNavigationState };
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return { ...createExpoRouterMock().module,
            Slot: () => {
                routeRuntime.childHydrationServerIds.push(routeParams.value.serverId ?? 'home-a');
                return React.createElement('SessionRouteSlot');
            },
            useLocalSearchParams: () => routeParams.value,
            usePathname: () => routeRuntime.pathname,
            useRouter: () => ({ setParams: routeRuntime.setParams, replace: routeRuntime.replace }),
        };
    },
});
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
afterAll(() => network.dispose());
const { storage } = await import('@/sync/domains/state/storage');
const { SessionInvalidLinkFallback } = await import('@/components/sessions/shell/SessionInvalidLinkFallback');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { DestinationInstanceHost, useDestinationParams } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { WorkspaceRouteOutlet } = await import('@/components/appShell/workspace/WorkspaceRouteOutlet');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { SessionViewerDestinationScope } = await import('@/components/sessions/viewer/SessionViewerDestinationScope');
await import('@/app/(app)/session/[id]/_layout');
const initialStorageState = storage.getState();
const baseMetadata = createSessionFixture().metadata;
const homesFixture = createSessionRouteHomesFixture();
const seedHomes = homesFixture.seed;
if (!baseMetadata) throw new Error('The canonical Session fixture must have readable metadata');

function Navigator(props: Readonly<{ children: React.ReactNode }>) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children: props.children });
    return <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>;
}
const Root = createNavigatorFactory(Navigator)();
let fixtureSeeded = false;
function layoutTree(Layout: React.ComponentType) {
    if (!fixtureSeeded) {
        storage.setState({
            sessions: sessionState.current ? { [sessionState.current.id]: sessionState.current } : {},
            sessionListIndexByServerId: lookupState.sessionListIndexByServerId,
            ordinarySessionListMembershipByServerId: lookupState.ordinarySessionListMembershipByServerId,
        });
        fixtureSeeded = true;
    }
    return <InjectedAuthProvider credentials={null}><BaseNavigationContainer><Root.Navigator><Root.Screen name="Session">{() => <Layout />}</Root.Screen></Root.Navigator></BaseNavigationContainer></InjectedAuthProvider>;
}

const routeParams = vi.hoisted(() => ({
    value: { id: 'session-1' } as Readonly<Record<string, string | undefined>>,
}));
const routeRuntime = vi.hoisted(() => ({
    pathname: '/session/session-1',
    childHydrationServerIds: [] as string[],
    setParams: vi.fn((params: Readonly<{ serverId?: string }>) => {
        routeParams.value = { ...routeParams.value, ...params };
    }),
    replace: vi.fn((href: Href) => {
        const url = new URL(resolveHref(href), 'https://app.example');
        routeParams.value = { id: 'session-1', serverId: url.searchParams.get('serverId') ?? undefined };
    }),
}));
const sessionState = vi.hoisted(() => ({
    current: null as ReturnType<typeof createSessionFixture> | null,
}));
const lookupState = vi.hoisted(() => ({
    sessionListIndexByServerId: {} as ReturnType<typeof storage.getState>['sessionListIndexByServerId'],
    ordinarySessionListMembershipByServerId: {} as Record<string, readonly string[]>,
}));

describe('ordinary session route layout', () => {
    afterEach(() => {
        standardCleanup();
        fixtureSeeded = false;
        routeParams.value = { id: 'session-1' };
        routeRuntime.pathname = '/session/session-1';
        sessionState.current = null;
        lookupState.sessionListIndexByServerId = {};
        lookupState.ordinarySessionListMembershipByServerId = {};
        routeRuntime.childHydrationServerIds = [];
        routeRuntime.setParams.mockClear();
        routeRuntime.replace.mockClear();
        homesFixture.restore();
        resetSessionListPaneRetentionForTests();
        storage.setState(initialStorageState, true);
    });

    it('does not mount ordinary session routes for the hidden Voice transcript history carrier', async () => {
        routeParams.value = { id: 'session-1', serverId: 'home-b' };
        sessionState.current = createSessionFixture({
            id: 'session-1',
            serverId: 'home-b',
            active: false,
            metadata: {
                ...baseMetadata,
                systemSessionV1: {
                    v: 1,
                    key: 'voice_transcript_history',
                    hidden: true,
                },
            },
        });
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(layoutTree(Layout.default));

        expect(screen.findAllByType(SessionInvalidLinkFallback)).toHaveLength(1);
        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(0);
    });

    it('keeps ordinary user sessions routed normally on the Home that holds them', async () => {
        sessionState.current = createSessionFixture({
            id: 'session-1',
            serverId: 'home-b',
            active: false,
            metadata: {
                ...baseMetadata,
                summary: {
                    text: 'Ordinary coding session',
                    updatedAt: 1,
                },
            },
        });
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(layoutTree(Layout.default));
        expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-1?serverId=home-b');
        await screen.update(layoutTree(Layout.default));

        expect(screen.findAllByType(SessionInvalidLinkFallback)).toHaveLength(0);
        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(1);
        expect(routeRuntime.childHydrationServerIds).toEqual(['home-b']);
    });

    it('never lets the focused Home answer a bare link to a Session no Home is known to hold', async () => {
        seedHomes(['home-a', 'home-b']);
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(layoutTree(Layout.default));

        // No hydration against the focused Home: the Which Home? chooser asks instead.
        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(0);
        expect(routeRuntime.childHydrationServerIds).toEqual([]);
        expect(routeRuntime.setParams).not.toHaveBeenCalled();
        expect(screen.findAllByType(SessionInvalidLinkFallback)[0]?.props).toMatchObject({
            sessionId: 'session-1',
            homeChoice: 'unknown',
        });
    });

    it('qualifies a native deep link whose route params carry a navigator object, keeping only its query strings', async () => {
        // A native deep link hands the layout expo-router's nested navigator params as an object beside the query.
        routeParams.value = { ...routeParams.value, params: { screen: 'info' } as unknown as string, tab: 'runs' };
        seedHomes(['home-b']);
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        const screen = await renderScreen(layoutTree(Layout));
        expect(screen.findAllByType(SessionInvalidLinkFallback)).toHaveLength(0);
        expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-1?serverId=home-b&tab=runs');
    });

    it('qualifies a fresh direct route on its sole Home before mounting child hydration', async () => {
        seedHomes(['home-b']);
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        const screen = await renderScreen(layoutTree(Layout));
        expect(screen.findAllByType(SessionInvalidLinkFallback)).toHaveLength(0);
        expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-1?serverId=home-b');
        await screen.update(layoutTree(Layout));
        expect(routeRuntime.childHydrationServerIds).toEqual(['home-b']);
    });

    it.each(['/new', '/session/session-10'])('does not let a retained legacy Session replace the active %s route when its Home resolves', async (pathname) => {
        seedHomes(['home-a', 'home-b']);
        routeRuntime.pathname = pathname;
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        const screen = await renderScreen(layoutTree(Layout));
        expect(routeRuntime.replace).not.toHaveBeenCalled();

        // Expo retains this layout's local params underneath another route. A later
        // store update can resolve its Home without granting it the current URL.
        await act(async () => {
            storage.setState({
                sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: 'home-b' }) },
            });
        });

        expect(routeRuntime.replace).not.toHaveBeenCalled();
        expect(routeParams.value).toEqual({ id: 'session-1' });
        expect(routeRuntime.childHydrationServerIds).toEqual([]);

        routeRuntime.pathname = '/session/session-1';
        await screen.update(layoutTree(Layout));
        expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-1?serverId=home-b');
        await screen.update(layoutTree(Layout));
        expect(routeRuntime.childHydrationServerIds).toEqual(['home-b']);
    });

    it('qualifies the retained destination through its navigation owner instead of Expo params', async () => {
        seedHomes(['home-b']);
        sessionState.current = createSessionFixture({ id: 'session-1', serverId: 'home-b' });
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        function HostedLayout() {
            const params = Object.fromEntries<string>(Object.entries(routeParams.value)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
            return <DestinationInstanceHost tabId="cold-session" ref={{ kind: 'session', params }}
                pathname="/session/session-1" focused visible navigation={{ push: vi.fn(), replace: routeRuntime.replace, back: vi.fn() }}>
                <WorkspaceRouteOutlet.Provider value={<SessionAddress />}><Layout /></WorkspaceRouteOutlet.Provider>
            </DestinationInstanceHost>;
        }
        function SessionAddress() {
            const params = useDestinationParams<{ id: string; serverId: string }>();
            return <QualifiedSessionRoute serverId={params.serverId} />;
        }
        function QualifiedSessionRoute(_props: Readonly<{ serverId: string }>) { return null; }
        const screen = await renderScreen(layoutTree(HostedLayout));
        expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-1?serverId=home-b');
        await screen.update(layoutTree(HostedLayout));
        expect(screen.findAllByType(QualifiedSessionRoute)[0]?.props.serverId).toBe('home-b');
        expect(routeRuntime.setParams).not.toHaveBeenCalled();
    });

    it('qualifies a hosted Session opened without a Home through its own destination navigation', async () => {
        seedHomes(['home-b']);
        const replace = vi.fn();
        await renderScreen(layoutTree(() => <DestinationInstanceHost tabId="bare-session" ref={{ kind: 'session', params: { id: 'session-1', right: 'files' } }}
            pathname="/session/session-1" focused visible navigation={{ push: vi.fn(), replace, back: vi.fn() }}>
            {null}
        </DestinationInstanceHost>));
        expect(replace).toHaveBeenCalledTimes(1);
        expect(replace).toHaveBeenCalledWith('/session/session-1?serverId=home-b&right=files');
    });

    it('preserves the direct file subroute and its target when qualifying a sole Home', async () => {
        seedHomes(['home-b']);
        routeRuntime.pathname = '/session/session-1/file';
        routeParams.value = { id: 'session-1', path: 'src/a.ts', startLine: '7' };
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        await renderScreen(layoutTree(Layout));
        expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-1/file?serverId=home-b&path=src%2Fa.ts&startLine=7');
    });

    it('leaves the Session viewer and Board scope to the hosted destination when Expo only mirrors its URL', async () => {
        routeParams.value = { id: 'session-1', serverId: 'home-b' };
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        const target = { kind: 'session' as const, params: { id: 'session-1', serverId: 'home-b' } };
        function MirroredLayout() {
            return <WorkspaceNavigationProvider value={{
                active: true, state: createWorkspaceState({ id: 'session-tab', target, pinned: false, preview: true }),
                canGoBack: false, canGoForward: false, openHref: () => true,
                activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
                navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
                registerBackStep: () => () => {}, back: () => {}, forward: () => {},
            }}><Layout /></WorkspaceNavigationProvider>;
        }

        const screen = await renderScreen(layoutTree(MirroredLayout));

        // The workspace's DestinationInstanceHost owns this Session's viewer and Board execution;
        // a second scope under Expo's URL mirror would run a duplicate Board controller per open.
        expect(screen.findAllByType(SessionViewerDestinationScope)).toHaveLength(0);
        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(1);
    });

    it('does not re-render the route layout while its Session record changes during a turn', async () => {
        routeParams.value = { id: 'session-1', serverId: 'home-b' };
        sessionState.current = createSessionFixture({ id: 'session-1', serverId: 'home-b', active: true });
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        const target = { kind: 'session' as const, params: { id: 'session-1', serverId: 'home-b' } };
        function MirroredLayout() {
            return <WorkspaceNavigationProvider value={{
                active: true, state: createWorkspaceState({ id: 'session-tab', target, pinned: false, preview: true }),
                canGoBack: false, canGoForward: false, openHref: () => true,
                activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
                navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
                registerBackStep: () => () => {}, back: () => {}, forward: () => {},
            }}><Layout /></WorkspaceNavigationProvider>;
        }
        await renderScreen(layoutTree(MirroredLayout));
        const rendersBefore = routeRuntime.childHydrationServerIds.length;

        // A streaming turn rewrites the Session record (seq, thinking, activity) many times.
        for (let seq = 2; seq <= 6; seq += 1) {
            const current = storage.getState().sessions['session-1']!;
            await act(async () => {
                storage.setState({ sessions: { 'session-1': { ...current, seq, thinking: seq % 2 === 0, thinkingAt: seq, updatedAt: seq } } });
            });
        }

        expect(routeRuntime.childHydrationServerIds.length - rendersBefore).toBe(0);
    });

    it('opens an explicitly qualified link directly, even when no Home is known to hold it', async () => {
        routeParams.value = { id: 'session-1', serverId: 'home-b' };
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(layoutTree(Layout.default));

        expect(screen.findAllByType(SessionInvalidLinkFallback)).toHaveLength(0);
        expect(routeRuntime.childHydrationServerIds).toEqual(['home-b']);
    });

    it('uses the selected retained Session Home instead of the outer Expo route', async () => {
        routeParams.value = { id: 'outer-session' };
        const { default: Layout } = await import('@/app/(app)/session/[id]/_layout');
        function HostedLeaf() {
            const params = useDestinationParams<{ id: string; serverId: string }>();
            return <SessionAddress id={params.id} serverId={params.serverId} />;
        }
        function SessionAddress(_props: Readonly<{ id: string; serverId: string }>) { return null; }
        function HostedLayout() {
            return <DestinationInstanceHost tabId="selected-session" ref={{ kind: 'session', params: { id: 'unknown-session', serverId: 'home-b' } }}
                pathname="/session/unknown-session" focused visible navigation={{ push: vi.fn(), replace: vi.fn(), back: vi.fn() }}>
                <WorkspaceRouteOutlet.Provider value={<HostedLeaf />}><Layout /></WorkspaceRouteOutlet.Provider>
            </DestinationInstanceHost>;
        }
        const screen = await renderScreen(layoutTree(HostedLayout));
        expect(screen.findAllByType(SessionInvalidLinkFallback)).toHaveLength(0);
        expect(screen.findAllByType(SessionAddress)[0]?.props).toEqual({ id: 'unknown-session', serverId: 'home-b' });
        expect(routeRuntime.childHydrationServerIds).toEqual([]);
        expect(routeRuntime.setParams).not.toHaveBeenCalled();
    });

    it('opens the Which Home fallback without mounting hydration for an ambiguous legacy route', async () => {
        lookupState.sessionListIndexByServerId = {
            'home-a': [{ type: 'session', sessionId: 'session-1', serverId: 'home-a' }],
            'home-b': [{ type: 'session', sessionId: 'session-1', serverId: 'home-b' }],
        };
        lookupState.ordinarySessionListMembershipByServerId = {
            'home-a': ['session-1'],
            'home-b': ['session-1'],
        };
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(layoutTree(Layout.default));

        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(0);
        expect(screen.findAllByType(SessionInvalidLinkFallback)[0]?.props).toMatchObject({
            sessionId: 'session-1',
            candidateServerIds: ['home-a', 'home-b'],
        });
    });

    it('threads active retained query membership into the legacy Which Home route', async () => {
        const queryState = (serverId: string) => ({
            requestedQueryKey: `query-${serverId}`, appliedQueryKey: `query-${serverId}`,
            addresses: [{ serverId, sessionId: 'session-1' }],
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            phase: 'ready' as const, freshnessAt: 1, failureReason: null, failureCode: null,
            homeObservation: { phase: 'ready' as const, lastSuccessAt: 1 },
            appliedSourceKind: 'query' as const,
        });
        retainSessionListPaneState({
            storageKind: 'all', pathname: '/', sourceScopeKey: 'test', queryMembershipActive: true,
            paneState: {
                summary: { sessionsReady: true, sessionCount: 2 }, visibleSessionListIndex: [],
                hasHiddenInactiveSessions: false, showLoading: false, showEmptyState: false,
                folderFeatureEnabledServerIds: [],
                query: {
                    active: true,
                    statesByServerId: { 'home-a': queryState('home-a'), 'home-b': queryState('home-b') },
                    byServerId: {}, source: [], coverageComplete: true,
                    loadNext: async () => {}, refresh: async () => {}, retry: async () => {},
                },
            },
        });
        const Layout = await import('@/app/(app)/session/[id]/_layout');
        const screen = await renderScreen(layoutTree(Layout.default));
        expect(screen.findAllByType('SessionRouteSlot')).toHaveLength(0);
        expect(screen.findAllByType(SessionInvalidLinkFallback)[0]?.props).toMatchObject({
            candidateServerIds: ['home-a', 'home-b'],
        });
    });

    it('promotes one current-query-only Home before mounting child hydration', async () => {
        retainSessionListPaneState({
            storageKind: 'all', pathname: '/', sourceScopeKey: 'test', queryMembershipActive: true,
            paneState: {
                summary: { sessionsReady: true, sessionCount: 1 }, visibleSessionListIndex: [],
                hasHiddenInactiveSessions: false, showLoading: false, showEmptyState: false,
                folderFeatureEnabledServerIds: [],
                query: {
                    active: true,
                    statesByServerId: {
                        'home-b': {
                            requestedQueryKey: 'query-home-b', appliedQueryKey: 'query-home-b',
                            addresses: [{ serverId: 'home-b', sessionId: 'session-1' }],
                            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                            phase: 'ready', freshnessAt: 1, failureReason: null, failureCode: null,
                            homeObservation: { phase: 'ready', lastSuccessAt: 1 },
                            appliedSourceKind: 'query',
                        },
                    },
                    byServerId: {}, source: [], coverageComplete: true,
                    loadNext: async () => {}, refresh: async () => {}, retry: async () => {},
                },
            },
        });
        const Layout = await import('@/app/(app)/session/[id]/_layout');

        const screen = await renderScreen(layoutTree(Layout.default));

        expect(routeRuntime.childHydrationServerIds).toEqual([]);
        expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-1?serverId=home-b');

        await screen.update(layoutTree(Layout.default));
        expect(routeRuntime.childHydrationServerIds).toEqual(['home-b']);
    });
});
