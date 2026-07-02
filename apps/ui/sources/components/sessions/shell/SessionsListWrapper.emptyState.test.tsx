import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionsListWrapper } from './SessionsListWrapper';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
    storageKinds: [] as string[],
    paneCalls: [] as Array<{ storageKind: string; pathname: string | null; sessionListSurfaceDataActive: boolean | null }>,
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
const gettingStartedState = vi.hoisted(() => ({
    kind: 'create_session' as 'create_session' | 'connect_machine' | 'start_daemon' | 'select_session' | 'loading',
}));

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
vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => focusState.focused,
}));
vi.mock('expo-router', () => ({
    usePathname: () => routeState.pathname,
}));

vi.mock('@/hooks/session/useVisibleSessionListPaneState', () => ({
    useVisibleSessionListPaneState: (storageKind?: string, options?: { pathname?: string; sessionListSurfaceDataActive?: boolean }) => {
        sessionListState.storageKinds.push(storageKind ?? 'all');
        sessionListState.paneCalls.push({
            storageKind: storageKind ?? 'all',
            pathname: options?.pathname ?? null,
            sessionListSurfaceDataActive: options?.sessionListSurfaceDataActive ?? null,
        });
        const data = sessionListState.data;
        const sessionCount = (data ?? []).filter((item) => item?.type === 'session').length;
        return {
            summary: {
                sessionsReady: true,
                sessionCount,
            },
            visibleSessionListViewData: data,
            folderFocus: null,
            showLoading: false,
            showEmptyState: sessionCount === 0,
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
        sessionListState.storageKinds = [];
        sessionListState.paneCalls = [];
        featureDecisionState.enabled = false;
        storageKindState.storageKind = 'persisted';
        storageKindState.setStorageKind.mockReset();
        gettingStartedState.kind = 'create_session';
        focusState.focused = true;
        routeState.pathname = '/';
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
            { storageKind: 'persisted', pathname: '/', sessionListSurfaceDataActive: true },
        ]);

        await screen.unmount();
    });

    it('keeps an initially unfocused phone root list unsubscribed', async () => {
        focusState.focused = false;
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        expect(screen.findByType('ActivitySpinner' as any)).toBeTruthy();
        expect(() => screen.findByType('SessionsListView' as any)).toThrow();

        await screen.unmount();
    });

    it('keeps an initially inactive foreground-route phone root list unsubscribed', async () => {
        routeState.pathname = '/new';
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([]);
        expect(screen.findByType('ActivitySpinner' as any)).toBeTruthy();
        expect(() => screen.findByType('SessionsListView' as any)).toThrow();

        await screen.unmount();
    });

    it('retains the last active phone root list while unsubscribing after focus loss', async () => {
        sessionListState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const screen = await renderScreen(<SessionsListWrapper pathname="/" />);

        expect(sessionListState.paneCalls).toEqual([
            { storageKind: 'persisted', pathname: '/', sessionListSurfaceDataActive: true },
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
            { storageKind: 'persisted', pathname: '/', sessionListSurfaceDataActive: true },
        ]);
        const list = screen.findByType('SessionsListView' as any);
        expect(list.props.pathname).toBe('/');
        expect(list.props.paneState.summary.sessionCount).toBe(1);
        expect(list.props.surfaceOwnership).toEqual({
            ownerKey: 'phone-root',
            visible: true,
            interactive: false,
            dataActive: false,
        });

        await screen.unmount();
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
