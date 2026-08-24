import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { VisibleSessionListViewDataOptions } from '@/hooks/session/useVisibleSessionListViewData';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
    storageKinds: [] as string[],
    paneOptions: [] as Array<VisibleSessionListViewDataOptions | undefined>,
    paneHookCalls: 0,
    contentRenderCalls: 0,
    paneVersion: 0,
    paneListeners: new Set<() => void>(),
}));
const routeState = vi.hoisted(() => ({
    pathname: '/',
    listeners: new Set<() => void>(),
}));
const emptyStateState = vi.hoisted(() => ({
    hasHiddenInactiveSessions: false,
}));
const featureDecisionState = vi.hoisted(() => ({
    enabled: false,
}));
const storageKindState = vi.hoisted(() => ({
    storageKind: 'persisted' as 'persisted' | 'direct',
    setStorageKind: vi.fn(),
}));
const serverSelectionState = vi.hoisted(() => ({
    selection: {
        activeTarget: { kind: 'server' as const, id: 'server-a', serverId: 'server-a' },
        activeServerId: 'server-a',
        allowedServerIds: ['server-a'],
        enabled: false,
        explicit: false,
        presentation: 'grouped' as const,
    },
}));
const accountScopeState = vi.hoisted(() => ({
    scope: { serverId: 'server-a', accountId: 'account-a' } as { serverId: string; accountId: string } | null,
}));
const focusState = vi.hoisted(() => ({
    isFocused: true,
    listeners: new Set<() => void>(),
}));
const draftListState = vi.hoisted(() => ({ count: 0 }));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                textSecondary: '#777',
                groupped: { background: '#fff' },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            // Reactive like the real router: a route change re-renders its subscribers, so a spec
            // can move the route on a mounted tree instead of only before mount.
            pathname: () => React.useSyncExternalStore(
                (listener) => {
                    routeState.listeners.add(listener);
                    return () => {
                        routeState.listeners.delete(listener);
                    };
                },
                () => routeState.pathname,
                () => routeState.pathname,
            ),
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useActiveServerAccountScope: () => accountScopeState.scope,
        });
    },
});
vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => serverSelectionState.selection,
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useActiveServerAccountScope: () => accountScopeState.scope,
    });
});
vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: (storageKind?: string) => {
        sessionListState.storageKinds.push(storageKind ?? 'all');
        return sessionListState.data;
    },
    useVisibleSessionListPaneState: (
        storageKind?: string,
        options?: VisibleSessionListViewDataOptions,
    ) => {
        const retainedVisibleDataRef = React.useRef<ReadonlyArray<{ type?: string }> | null>(null);
        const visibleData: ReadonlyArray<{ type?: string }> | null = sessionListState.data
            ?? options?.retainedSessionListViewData
            ?? retainedVisibleDataRef.current
            ?? null;
        React.useSyncExternalStore(
            (listener) => {
                sessionListState.paneListeners.add(listener);
                return () => {
                    sessionListState.paneListeners.delete(listener);
                };
            },
            () => sessionListState.paneVersion,
            () => sessionListState.paneVersion,
        );
        React.useEffect(() => {
            retainedVisibleDataRef.current = visibleData;
        }, [visibleData]);
        sessionListState.paneHookCalls += 1;
        sessionListState.storageKinds.push(storageKind ?? 'all');
        sessionListState.paneOptions.push(options);
        return {
            sessionListViewData: visibleData,
            visibleSessionCount: visibleData?.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0) ?? 0,
            hasHiddenInactiveSessions: emptyStateState.hasHiddenInactiveSessions,
        };
    },
    useHasHiddenInactiveSessions: () => emptyStateState.hasHiddenInactiveSessions,
    countVisibleSessionListSessions: (data: Array<{ type?: string }> | null) => (
        data?.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0) ?? 0
    ),
}));
vi.mock('@/components/sessions/model/useSessionListStorageKind', () => ({
    useSessionListStorageKind: () => ({
        directSessionsEnabled: featureDecisionState.enabled,
        storageKind: featureDecisionState.enabled ? storageKindState.storageKind : 'persisted',
        setStorageKind: storageKindState.setStorageKind,
    }),
}));
vi.mock('@/components/sessions/shell/SessionsListStorageChrome', () => ({
    SessionsListStorageChrome: (props: any) => React.createElement('SessionsListStorageChrome', props),
}));
vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/HiddenInactiveSessionsEmptyState', () => ({
    HiddenInactiveSessionsEmptyState: 'HiddenInactiveSessionsEmptyState',
}));
vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: (props: any) => React.createElement('SessionsList', props),
    SessionsListContent: (props: any) => {
        sessionListState.contentRenderCalls += 1;
        return React.createElement('SessionsListContent', props);
    },
}));
vi.mock('@/components/sessions/shell/NewSessionDraftsSection', () => ({
    useNewSessionDraftProjections: () => Array.from({ length: draftListState.count }, (_, index) => ({
        draftId: `draft-${index}`,
    })),
}));
vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => React.useSyncExternalStore(
        (listener) => {
            focusState.listeners.add(listener);
            return () => {
                focusState.listeners.delete(listener);
            };
        },
        () => focusState.isFocused,
        () => focusState.isFocused,
    ),
}));
async function setRoutePathname(pathname: string) {
    await act(async () => {
        routeState.pathname = pathname;
        for (const listener of [...routeState.listeners]) listener();
    });
    await flushHookEffects();
}

async function renderSessionsListWrapper() {
    const { SessionsListWrapper } = await import('./SessionsListWrapper');
    return renderScreen(<SessionsListWrapper />);
}

describe('SessionsListWrapper (empty state)', () => {
    beforeEach(async () => {
        sessionListState.data = [];
        sessionListState.storageKinds = [];
        sessionListState.paneOptions = [];
        sessionListState.paneHookCalls = 0;
        sessionListState.contentRenderCalls = 0;
        sessionListState.paneVersion = 0;
        sessionListState.paneListeners.clear();
        routeState.pathname = '/';
        routeState.listeners.clear();
        emptyStateState.hasHiddenInactiveSessions = false;
        featureDecisionState.enabled = false;
        storageKindState.storageKind = 'persisted';
        storageKindState.setStorageKind.mockReset();
        serverSelectionState.selection = {
            activeTarget: { kind: 'server', id: 'server-a', serverId: 'server-a' },
            activeServerId: 'server-a',
            allowedServerIds: ['server-a'],
            enabled: false,
            explicit: false,
            presentation: 'grouped',
        };
        accountScopeState.scope = { serverId: 'server-a', accountId: 'account-a' };
        focusState.isFocused = true;
        focusState.listeners.clear();
        draftListState.count = 0;
        const { resetSessionListPaneRetentionForTests } = await import('./surface/sessionListPaneRetention');
        resetSessionListPaneRetentionForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('renders getting started guidance when there are no sessions', async () => {
        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).not.toThrow();

        await screen.unmount();
    });

    it('renders the real list surface when drafts exist without sessions', async () => {
        draftListState.count = 2;

        const screen = await renderSessionsListWrapper();

        expect(screen.findByType('SessionsListContent' as any).props.data).toEqual([]);
        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).toThrow();

        await screen.unmount();
    });

    it('uses the persisted storage filter when direct sessions are disabled', async () => {
        const screen = await renderSessionsListWrapper();

        expect(sessionListState.storageKinds.length).toBeGreaterThan(0);
        expect(sessionListState.storageKinds.every((kind) => kind === 'persisted')).toBe(true);

        await screen.unmount();
    });

    it('shows storage tabs and uses the selected direct storage filter when direct sessions are enabled', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        expect(sessionListState.storageKinds.length).toBeGreaterThan(0);
        expect(sessionListState.storageKinds.every((kind) => kind === 'direct')).toBe(true);
        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListContent' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListContent' as any).props.data).toBe(sessionListState.data);

        await screen.unmount();
    });

    it('keeps the storage chrome visible in the direct empty state', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [];

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');

        await screen.unmount();
    });

    it('renders the hidden inactive sessions notice when the filter hides every session', async () => {
        emptyStateState.hasHiddenInactiveSessions = true;

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('HiddenInactiveSessionsEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).toThrow();

        await screen.unmount();
    });

    it('treats header-only list data as empty when hidden inactive sessions removed all actual session rows', async () => {
        emptyStateState.hasHiddenInactiveSessions = true;
        sessionListState.data = [{ type: 'header', title: 'Today' }];

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('HiddenInactiveSessionsEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the storage chrome visible when the direct tab already has sessions', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListContent' as any).props.storageKind).toBe('direct');

        await screen.unmount();
    });

    it('passes the precomputed visible list to the rendered sessions list path', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        expect(sessionListState.paneHookCalls).toBeGreaterThanOrEqual(1);
        expect(sessionListState.storageKinds.every((kind) => kind === 'direct')).toBe(true);
        expect(screen.findByType('SessionsListContent' as any).props.data).toBe(sessionListState.data);

        await screen.unmount();
    });

    it('marks the list inactive while retaining native list content on focus loss', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderSessionsListWrapper();

        act(() => {
            focusState.isFocused = false;
            for (const listener of Array.from(focusState.listeners)) {
                listener();
            }
        });

        expect(sessionListState.paneOptions).toContainEqual({
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        });
        expect(screen.findByType('SessionsListContent' as any).props.surfaceOwnership).toMatchObject({
            visible: true,
            interactive: false,
            dataActive: false,
        });
        await screen.unmount();
    });

    it('reuses retained root-list data after focus restoration even when the active session id is null', async () => {
        const retainedData = [{ type: 'session', session: { id: 'session-1' } }];
        sessionListState.data = retainedData;

        const screen = await renderSessionsListWrapper();

        act(() => {
            focusState.isFocused = false;
            for (const listener of Array.from(focusState.listeners)) {
                listener();
            }
        });

        sessionListState.data = null;

        act(() => {
            focusState.isFocused = true;
            for (const listener of Array.from(focusState.listeners)) {
                listener();
            }
        });

        expect(sessionListState.paneOptions).toContainEqual({
            activeSessionId: null,
            retainedSessionListViewData: retainedData,
            sessionListSurfaceDataActive: true,
        });
        expect(screen.findByType('SessionsListContent' as any).props.data).toBe(retainedData);

        await screen.unmount();
    });

    it('reuses retained root-list data when the root list remounts on / with no active session id', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const retainedData = [{ type: 'session', session: { id: 'session-1' } }];
        sessionListState.data = retainedData;
        routeState.pathname = '/';

        const initialScreen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(initialScreen.findByType('SessionsListContent' as any).props.data).toBe(retainedData);

        await initialScreen.unmount();
        sessionListState.paneOptions = [];
        sessionListState.data = null;

        const remountedScreen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.paneOptions).toContainEqual({
            activeSessionId: null,
            retainedSessionListViewData: retainedData,
            sessionListSurfaceDataActive: true,
        });
        expect(remountedScreen.findByType('SessionsListContent' as any).props.data).toBe(retainedData);

        await remountedScreen.unmount();
    });

    it('passes active-session identity while marking foreground session routes inactive', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        routeState.pathname = '/session/session-2';

        const screen = await renderSessionsListWrapper();

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('uses an explicit pathname without treating it as the foreground surface route', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        routeState.pathname = '/session/session-2';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the inactive new-session sheet surface unsubscribed until the root list becomes active', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        focusState.isFocused = true;
        routeState.pathname = '/new';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/new" />);

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the inactive foreground session route surface unsubscribed until the root list becomes active', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];
        focusState.isFocused = true;
        routeState.pathname = '/session/session-2';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/session-2" />);

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => screen.findByType('SessionsListContent' as any)).toThrow();

        await screen.unmount();
    });

    it('seeds retained pane data and foreground session identity when returning from a foreground session route', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const retainedData = [{ type: 'session', session: { id: 'session-2' } }];
        sessionListState.data = retainedData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.paneOptions[0]).toEqual({
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        });
        const initialPaneOptionCount = sessionListState.paneOptions.length;

        routeState.pathname = '/session/session-2';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/session-2" />);
        expect(sessionListState.paneOptions).toHaveLength(initialPaneOptionCount);

        routeState.pathname = '/';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.paneOptions.at(-1)).toEqual({
            activeSessionId: 'session-2',
            sessionListSurfaceDataActive: true,
        });
        expect(screen.findByType('SessionsListContent' as any).props.data).toBe(retainedData);

        await screen.unmount();
    });

    it('keeps the retained foreground session identity while an overlay route is open over that session', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const retainedData = [{ type: 'session', session: { id: 'session-2' } }];
        sessionListState.data = retainedData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneOptions[0]).toEqual({
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        });

        await setRoutePathname('/session/session-2');
        // The new-session modal opens over the session route; it does not replace it, so the list
        // must stay anchored to that session rather than forgetting which one is in the foreground.
        await setRoutePathname('/new');
        await setRoutePathname('/');

        expect(sessionListState.paneOptions.at(-1)).toEqual({
            activeSessionId: 'session-2',
            sessionListSurfaceDataActive: true,
        });

        await screen.unmount();
    });

    it('renders the last active pane snapshot after the retained phone list remounts inactive', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const retainedData = [{ type: 'session', session: { id: 'session-2' } }];
        sessionListState.data = retainedData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const activeScreen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(activeScreen.findByType('SessionsListContent' as any).props.data).toBe(retainedData);

        await activeScreen.unmount();
        sessionListState.paneOptions = [];
        routeState.pathname = '/session/session-2';
        sessionListState.data = null;

        const inactiveScreen = await renderScreen(
            <SessionsListWrapper pathname="/" surfaceRoutePathname="/session/session-2" />,
        );

        expect(sessionListState.paneOptions).toEqual([]);
        expect(inactiveScreen.findByType('SessionsListContent' as any).props.data).toBe(retainedData);
        expect(inactiveScreen.findByType('SessionsListContent' as any).props.surfaceOwnership).toMatchObject({
            visible: true,
            interactive: false,
            dataActive: false,
        });

        await inactiveScreen.unmount();
    });

    it('does not render a retained pane snapshot after the selected server scope changes', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const serverAData = [{ type: 'session', serverId: 'server-a', session: { id: 'session-a' } }];
        sessionListState.data = serverAData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const activeScreen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(activeScreen.findByType('SessionsListContent' as any).props.data).toBe(serverAData);

        await activeScreen.unmount();
        sessionListState.paneOptions = [];
        routeState.pathname = '/session/session-a';
        sessionListState.data = null;
        serverSelectionState.selection = {
            activeTarget: { kind: 'server', id: 'server-b', serverId: 'server-b' },
            activeServerId: 'server-b',
            allowedServerIds: ['server-b'],
            enabled: false,
            explicit: false,
            presentation: 'grouped',
        };
        accountScopeState.scope = { serverId: 'server-b', accountId: 'account-a' };

        const inactiveScreen = await renderScreen(
            <SessionsListWrapper pathname="/" surfaceRoutePathname="/session/session-a" />,
        );

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => inactiveScreen.findByType('SessionsListContent' as any)).toThrow();

        await inactiveScreen.unmount();
    });

    it('does not render a retained pane snapshot after the active account scope changes', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const accountAData = [{ type: 'session', serverId: 'server-a', session: { id: 'session-a' } }];
        sessionListState.data = accountAData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const activeScreen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(activeScreen.findByType('SessionsListContent' as any).props.data).toBe(accountAData);

        await activeScreen.unmount();
        sessionListState.paneOptions = [];
        routeState.pathname = '/session/session-a';
        sessionListState.data = null;
        accountScopeState.scope = { serverId: 'server-a', accountId: 'account-b' };

        const inactiveScreen = await renderScreen(
            <SessionsListWrapper pathname="/" surfaceRoutePathname="/session/session-a" />,
        );

        expect(sessionListState.paneOptions).toEqual([]);
        expect(() => inactiveScreen.findByType('SessionsListContent' as any)).toThrow();

        await inactiveScreen.unmount();
    });

    it('does not seed retained pane data after the storage kind changes while returning from a foreground session route', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        const persistedData = [{ type: 'session', session: { id: 'persisted-session' } }];
        const directData = [{ type: 'session', session: { id: 'direct-session' } }];
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'persisted';
        sessionListState.data = persistedData;
        focusState.isFocused = true;
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.paneOptions[0]).toEqual({
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        });
        const initialPaneOptionCount = sessionListState.paneOptions.length;

        routeState.pathname = '/session/persisted-session';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/persisted-session" />);
        expect(sessionListState.paneOptions).toHaveLength(initialPaneOptionCount);

        storageKindState.storageKind = 'direct';
        sessionListState.data = directData;
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/session/persisted-session?storage=direct" />);
        await flushHookEffects({ cycles: 1, turns: 4 });
        expect(sessionListState.paneOptions).toHaveLength(initialPaneOptionCount);

        routeState.pathname = '/';
        await screen.update(<SessionsListWrapper pathname="/" surfaceRoutePathname="/" />);

        expect(sessionListState.storageKinds.at(-1)).toBe('direct');
        expect(sessionListState.paneOptions.at(-1)).toEqual({
            activeSessionId: null,
            sessionListSurfaceDataActive: true,
        });

        await screen.unmount();
    });

    it('does not re-render the list content when wrapper-only state changes keep the same visible data', async () => {
        const { SessionsListWrapper } = await import('./SessionsListWrapper');
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper />);
        expect(sessionListState.contentRenderCalls).toBe(1);

        await act(async () => {
            sessionListState.paneVersion += 1;
            for (const listener of sessionListState.paneListeners) {
                listener();
            }
        });

        expect(sessionListState.paneHookCalls).toBeGreaterThanOrEqual(2);
        expect(sessionListState.contentRenderCalls).toBe(1);

        await screen.unmount();
    });
});
