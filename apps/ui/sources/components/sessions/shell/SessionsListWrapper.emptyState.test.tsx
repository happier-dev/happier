import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderScreenWithProviders, standardCleanup } from '@/dev/testkit';
import { NavigationContext, useNavigation } from '@react-navigation/native';
import type { VisibleSessionListPaneStateOptions } from '@/hooks/session/useVisibleSessionListPaneState';
import { SessionsListWrapper } from './SessionsListWrapper';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { readActiveRetainedSessionListQueryStates, resetSessionListPaneRetentionForTests } from './sessionListPaneRetention';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
    query: undefined as any,
    storageKinds: [] as string[],
    paneCalls: [] as Array<{
        storageKind: string;
        pathname: string | null;
        retainedPathname: string | null;
        retainedVisibleSessionListIndex: VisibleSessionListPaneStateOptions['retainedVisibleSessionListIndex'] | null;
        sessionListSurfaceDataActive: boolean | null;
    }>,
}));
const focusState = vi.hoisted(() => ({
    focused: true,
}));
const routeState = vi.hoisted(() => ({
    pathname: '/',
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
    accountIdByServerId: new Map([
        ['server-a', 'account-a'],
        ['server-b', 'account-b'],
    ]),
}));
const gettingStartedState = vi.hoisted(() => ({
    kind: 'create_session' as 'create_session' | 'connect_machine' | 'start_daemon' | 'select_session' | 'loading',
}));

function ScreenNavigationProvider({ children }: React.PropsWithChildren) {
    const navigation = useNavigation<NonNullable<React.ContextType<typeof NavigationContext>>>();
    return <NavigationContext.Provider value={navigation}>
        {children}
    </NavigationContext.Provider>;
}

function renderScreen(element: React.ReactElement) {
    return renderScreenWithProviders(element, { wrapper: ScreenNavigationProvider });
}

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
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        // These scenarios render a navigator-owned screen, so the optional focus
        // reader must observe a navigation context rather than a standalone host.
        NavigationContext: React.createContext({}),
        useIsFocused: () => focusState.focused,
    };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock();
    return { ...boundary.module, usePathname: () => routeState.pathname };
});
vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => serverSelectionState.selection,
    // The canonical list's filter controller resolves feature decisions, which read
    // the effective selection through this same owner.
    useEffectiveServerSelection: () => ({
        ...serverSelectionState.selection,
        serverIds: serverSelectionState.selection.allowedServerIds,
    }),
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useActiveServerAccountScope: () => accountScopeState.scope,
    });
});

vi.mock('@/hooks/session/useVisibleSessionListPaneState', () => ({
    useVisibleSessionListPaneState: (
        storageKind?: string,
        options?: VisibleSessionListPaneStateOptions,
    ) => {
        sessionListState.storageKinds.push(storageKind ?? 'all');
        sessionListState.paneCalls.push({
            storageKind: storageKind ?? 'all',
            pathname: options?.pathname ?? null,
            retainedPathname: options?.retainedPathname ?? null,
            retainedVisibleSessionListIndex: options?.retainedVisibleSessionListIndex ?? null,
            sessionListSurfaceDataActive: options?.sessionListSurfaceDataActive ?? null,
        });
        const data = sessionListState.data;
        const sessionCount = (data ?? []).filter((item) => item?.type === 'session').length;
        return {
            summary: {
                sessionsReady: true,
                sessionCount,
            },
            visibleSessionListIndex: data,
            folderFocus: null,
            hasHiddenInactiveSessions: false,
            showLoading: false,
            showEmptyState: sessionCount === 0,
            query: sessionListState.query,
        };
    },
}));
vi.mock('@/components/sessions/model/useSessionListStorageKind', () => ({
    useSessionListStorageKind: () => ({
        externalSessionsEnabled: featureDecisionState.enabled,
        storageKind: featureDecisionState.enabled ? storageKindState.storageKind : 'persisted',
        setStorageKind: storageKindState.setStorageKind,
    }),
}));
vi.mock('./search/useSessionListViewFilterController', () => ({
    useSessionListViewFilterController: () => {
        const serverIds = [...serverSelectionState.selection.allowedServerIds].sort();
        return {
            sourceAvailable: featureDecisionState.enabled,
            filters: { source: storageKindState.storageKind },
            queryHomes: [],
            pagingHomes: [],
            retentionScopeKey: JSON.stringify(serverIds.map((serverId) => [
                serverId,
                accountScopeState.accountIdByServerId.get(serverId) ?? null,
            ])),
        };
    },
}));
vi.mock('@/components/sessions/shell/SessionsListStorageChrome', () => ({
    SessionsListStorageChrome: (props: any) => React.createElement('SessionsListStorageChrome', props),
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));
vi.mock('./SessionsListEmptyState', () => ({
    SessionsListEmptyState: 'SessionsListEmptyState',
}));
vi.mock('./ExternalSessionsEmptyState', () => ({
    ExternalSessionsEmptyState: 'ExternalSessionsEmptyState',
}));
vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => ({
        kind: gettingStartedState.kind,
        targetLabel: 'leeroy-mbp',
        serverUrl: 'http://example.test',
        serverName: 'server-1',
        showServerSetup: false,
    }),
}));
vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: (props: any) => React.createElement('SessionsList', props),
    SessionsListView: (props: any) => React.createElement('SessionsListView', props),
    SessionsListViewWithFilterController: (props: any) => React.createElement('SessionsListView', props),
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('SessionsListWrapper (empty state)', () => {
    beforeEach(() => {
        sessionListState.data = [];
        sessionListState.query = undefined;
        sessionListState.storageKinds = [];
        sessionListState.paneCalls = [];
        featureDecisionState.enabled = false;
        storageKindState.storageKind = 'persisted';
        storageKindState.setStorageKind.mockReset();
        gettingStartedState.kind = 'create_session';
        serverSelectionState.selection = {
            activeTarget: { kind: 'server', id: 'server-a', serverId: 'server-a' },
            activeServerId: 'server-a',
            allowedServerIds: ['server-a'],
            enabled: false,
            explicit: false,
            presentation: 'grouped',
        };
        accountScopeState.scope = { serverId: 'server-a', accountId: 'account-a' };
        accountScopeState.accountIdByServerId = new Map([
            ['server-a', 'account-a'],
            ['server-b', 'account-b'],
        ]);
        focusState.focused = true;
        routeState.pathname = '/';
        resetSessionListPaneRetentionForTests();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the projects-style empty state when there are no sessions and session creation is available', async () => {
        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionsListEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).toThrow();

        await screen.unmount();
    });

    it('exposes query membership only while its pane owns active Session-list data', async () => {
        sessionListState.query = {
            active: true,
            statesByServerId: {
                'team-home': {
                    requestedQueryKey: 'team-query', appliedQueryKey: 'team-query',
                    addresses: [{ serverId: 'team-home', sessionId: 'team-only' }],
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                    phase: 'ready', freshnessAt: 1, failureReason: null, failureCode: null, appliedSourceKind: 'query',
                },
            },
        };
        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);
        expect(readActiveRetainedSessionListQueryStates()).toHaveLength(1);
        await screen.unmount();
        expect(readActiveRetainedSessionListQueryStates()).toEqual([]);
    });

    it('keeps using the shared sessions empty state when this computer needs to reconnect', async () => {
        gettingStartedState.kind = 'connect_machine';

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionsListEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).toThrow();

        await screen.unmount();
    });

    it('reuses the shared sessions empty state for select-session guidance', async () => {
        gettingStartedState.kind = 'select_session';

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionsListEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).toThrow();

        await screen.unmount();
    });

    it('uses the persisted storage filter when direct sessions are disabled', async () => {
        const screen = await renderScreen(<SessionsListWrapper />);

        expect(sessionListState.storageKinds).toEqual(['persisted']);

        await screen.unmount();
    });

    it('threads a retained pathname override into the pane state owner', async () => {
        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([
            {
                storageKind: 'persisted',
                pathname: '/',
                retainedPathname: null,
                retainedVisibleSessionListIndex: null,
                sessionListSurfaceDataActive: true,
            },
        ]);

        await screen.unmount();
    });

    it('seeds retained index and foreground pathname when returning from a foreground session route', async () => {
        const retainedIndex = [{ type: 'session', sessionId: 'done', serverId: 'server-1', groupKind: 'attention' }];
        sessionListState.data = retainedIndex;
        routeState.pathname = '/';

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([{
            storageKind: 'persisted',
            pathname: '/',
            retainedPathname: null,
            retainedVisibleSessionListIndex: null,
            sessionListSurfaceDataActive: true,
        }]);

        routeState.pathname = '/session/done';
        await screen.update(<SessionsListWrapper pathname="/" />);
        expect(sessionListState.paneCalls).toHaveLength(1);

        routeState.pathname = '/';
        await screen.update(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls[1]).toEqual({
            storageKind: 'persisted',
            pathname: '/',
            retainedPathname: '/session/done',
            retainedVisibleSessionListIndex: retainedIndex,
            sessionListSurfaceDataActive: true,
        });

        await screen.unmount();
    });

    it('keeps an initially unfocused phone root list unsubscribed', async () => {
        focusState.focused = false;
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        expect(screen.findByTestId('session-list-skeleton')).toBeTruthy();
        expect(() => screen.findByType('SessionsListView' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps an initially inactive foreground-route phone root list unsubscribed', async () => {
        routeState.pathname = '/new';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        expect(screen.findByTestId('session-list-skeleton')).toBeTruthy();
        expect(() => screen.findByType('SessionsListView' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the phone root list painted and frozen while an overlay route is open over it', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(screen.findByType('SessionsListView' as any).props.surfaceOwnership).toEqual({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });

        // The new-session modal is presented over the root list, not in place of it: the list must
        // stay painted with its last active snapshot, non-interactive and unsubscribed.
        focusState.focused = false;
        routeState.pathname = '/new';
        await screen.update(<SessionsListWrapper pathname="/" />);

        const list = screen.findByType('SessionsListView' as any);
        expect(list.props.paneState.summary.sessionCount).toBe(1);
        expect(list.props.surfaceOwnership).toEqual({
            ownerKey: 'phone-root',
            visible: true,
            interactive: false,
            dataActive: false,
        });

        await screen.unmount();
    });

    it('retains the last active phone root list while unsubscribing after focus loss', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([
            {
                storageKind: 'persisted',
                pathname: '/',
                retainedPathname: null,
                retainedVisibleSessionListIndex: null,
                sessionListSurfaceDataActive: true,
            },
        ]);
        expect(screen.findByType('SessionsListView' as any).props.surfaceOwnership).toEqual({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });

        focusState.focused = false;
        await screen.update(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([
            {
                storageKind: 'persisted',
                pathname: '/',
                retainedPathname: null,
                retainedVisibleSessionListIndex: null,
                sessionListSurfaceDataActive: true,
            },
        ]);
        const list = screen.findByType('SessionsListView' as any);
        expect(list.props.pathname).toBe('/');
        expect(list.props.paneState.summary.sessionCount).toBe(1);
        expect(list.props.surfaceOwnership).toEqual({
            ownerKey: 'phone-root',
            visible: false,
            interactive: false,
            dataActive: false,
        });

        await screen.unmount();
    });

    it('renders the last active pane snapshot after the retained phone list remounts inactive', async () => {
        const retainedIndex = [{ type: 'session', session: { id: 'session-1' } }];
        sessionListState.data = retainedIndex;

        const activeScreen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(activeScreen.findByType('SessionsListView' as any).props.paneState.visibleSessionListIndex).toBe(retainedIndex);

        await activeScreen.unmount();

        sessionListState.data = null;
        sessionListState.paneCalls = [];
        routeState.pathname = '/session/session-1';

        const inactiveScreen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        const list = inactiveScreen.findByType('SessionsListView' as any);
        expect(list.props.paneState.visibleSessionListIndex).toBe(retainedIndex);
        expect(list.props.surfaceOwnership).toEqual({
            ownerKey: 'phone-root',
            visible: true,
            interactive: false,
            dataActive: false,
        });

        await inactiveScreen.unmount();
    });

    it('does not render a retained pane snapshot after the selected server scope changes', async () => {
        const serverAIndex = [{ type: 'session', sessionId: 'session-a', serverId: 'server-a' }];
        sessionListState.data = serverAIndex;

        const activeScreen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(activeScreen.findByType('SessionsListView' as any).props.paneState.visibleSessionListIndex).toBe(serverAIndex);

        await activeScreen.unmount();

        sessionListState.data = null;
        sessionListState.paneCalls = [];
        routeState.pathname = '/session/session-a';
        serverSelectionState.selection = {
            activeTarget: { kind: 'server', id: 'server-b', serverId: 'server-b' },
            activeServerId: 'server-b',
            allowedServerIds: ['server-b'],
            enabled: false,
            explicit: false,
            presentation: 'grouped',
        };
        accountScopeState.scope = { serverId: 'server-b', accountId: 'account-a' };

        const inactiveScreen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        expect(() => inactiveScreen.findByType('SessionsListView' as any)).toThrow();
        expect(inactiveScreen.findByTestId('session-list-skeleton')).toBeTruthy();

        await inactiveScreen.unmount();
    });

    it('retains the global A+B pane when focus moves from A to B inside the same credential corpus', async () => {
        serverSelectionState.selection = {
            activeTarget: { kind: 'server', id: 'server-a', serverId: 'server-a' },
            activeServerId: 'server-a',
            allowedServerIds: ['server-a', 'server-b'],
            enabled: true,
            explicit: true,
            presentation: 'grouped',
        };
        const retainedIndex = [
            { type: 'session', sessionId: 'session-a', serverId: 'server-a' },
            { type: 'session', sessionId: 'session-b', serverId: 'server-b' },
        ];
        sessionListState.data = retainedIndex;
        const activeScreen = await renderScreen(<SessionsListWrapper pathname="/" />);
        await activeScreen.unmount();

        sessionListState.data = null;
        sessionListState.paneCalls = [];
        routeState.pathname = '/session/session-b';
        serverSelectionState.selection = {
            ...serverSelectionState.selection,
            activeTarget: { kind: 'server', id: 'server-b', serverId: 'server-b' },
            activeServerId: 'server-b',
        };
        accountScopeState.scope = { serverId: 'server-b', accountId: 'account-b' };

        const inactiveScreen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        expect(inactiveScreen.findByType('SessionsListView' as any).props.paneState.visibleSessionListIndex)
            .toBe(retainedIndex);
        await inactiveScreen.unmount();
    });

    it('does not render a retained pane snapshot after the active account scope changes', async () => {
        const accountAIndex = [{ type: 'session', sessionId: 'session-a', serverId: 'server-a' }];
        sessionListState.data = accountAIndex;

        const activeScreen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(activeScreen.findByType('SessionsListView' as any).props.paneState.visibleSessionListIndex).toBe(accountAIndex);

        await activeScreen.unmount();

        sessionListState.data = null;
        sessionListState.paneCalls = [];
        routeState.pathname = '/session/session-a';
        accountScopeState.scope = { serverId: 'server-a', accountId: 'account-b' };
        accountScopeState.accountIdByServerId.set('server-a', 'account-b');

        const inactiveScreen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        expect(() => inactiveScreen.findByType('SessionsListView' as any)).toThrow();
        expect(inactiveScreen.findByTestId('session-list-skeleton')).toBeTruthy();

        await inactiveScreen.unmount();
    });

    it('shows storage tabs and uses the selected direct storage filter when direct sessions are enabled', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(sessionListState.storageKinds).toEqual(['direct']);
        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListView' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListView' as any).props.data).toBeUndefined();
        expect(() => screen.findByType('SessionsList' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the storage chrome visible in the direct empty state', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [];

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(() => screen.findByType('ExternalSessionsEmptyState' as any)).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance' as any)).toThrow();
        expect(() => screen.findByType('SessionsList' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps the storage chrome visible when the direct tab already has sessions', async () => {
        featureDecisionState.enabled = true;
        storageKindState.storageKind = 'direct';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(() => screen.findByType('SessionsListStorageChrome' as any)).not.toThrow();
        expect(screen.findByType('SessionsListStorageChrome' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListView' as any).props.storageKind).toBe('direct');
        expect(screen.findByType('SessionsListView' as any).props.data).toBeUndefined();
        expect(() => screen.findByType('SessionsList' as any)).toThrow();

        await screen.unmount();
    });

    it('passes precomputed visible data to SessionsListView for persisted non-empty sessions', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-2' } }];

        const screen = await renderScreen(<SessionsListWrapper />);

        expect(sessionListState.storageKinds).toEqual(['persisted']);
        expect(screen.findByType('SessionsListView' as any).props.storageKind).toBe('persisted');
        expect(screen.findByType('SessionsListView' as any).props.data).toBeUndefined();
        expect(() => screen.findByType('SessionsList' as any)).toThrow();

        await screen.unmount();
    });
});
