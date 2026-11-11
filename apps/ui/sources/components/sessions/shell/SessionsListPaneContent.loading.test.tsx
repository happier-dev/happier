import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    calls: 0,
    callOptions: [] as Array<Record<string, unknown> | undefined>,
    paneState: {
        summary: {
            sessionsReady: false,
            sessionCount: 0,
        },
        visibleSessionListViewData: [{ type: 'session', session: { id: 'session-1' } }] as any[],
        hasHiddenInactiveSessions: false,
        showLoading: true,
        showEmptyState: false,
    },
}));

const filterControllerState = vi.hoisted(() => ({
    controller: {
        get displayFilters() { return this.filters; },
        filters: {
            scope: 'my_work',
            attention: 'any',
            homeServerIds: ['home-a'],
            audiences: [],
            tagIds: [],
            source: 'all',
            searchQuery: '',
        },
        queryEnabled: true,
        queryHomes: [{ serverId: 'home-a', queryKey: 'query-a', query: {} }],
        // The canonical controller exposes one paging-homes decision; the pane no
        // longer re-derives it from `queryEnabled`.
        pagingHomes: [{ serverId: 'home-a', queryKey: 'query-a', query: {} }],
        sourceAvailable: true,
        retentionScopeKey: 'global:home-a',
    },
}));

installSessionShellCommonModuleMocks({
    // The testkit storage stub: the pane's data hooks are mocked here, and passing the real store through hits the
    // storage → hooks → scm → apiSocket → storage import cycle under vi.mock (sessionShellTestHelpers.ts:134).
    storage: async () => ({}),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: 'ActivityIndicator',
            View: 'View',
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

vi.mock('@/hooks/session/useVisibleSessionListPaneState', () => ({
    useVisibleSessionListPaneState: (_storageKind: string, options?: Record<string, unknown>) => {
        sessionListState.calls += 1;
        sessionListState.callOptions.push(options);
        return sessionListState.paneState;
    },
}));

vi.mock('./search/useSessionListViewFilterController', () => ({
    useSessionListViewFilterController: () => filterControllerState.controller,
}));

vi.mock('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => ({
        kind: 'create_session',
        targetLabel: 'server-1',
        serverUrl: 'http://example.test',
        serverName: 'server-1',
        showServerSetup: false,
    }),
}));

vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsListView: (props: any) => React.createElement('SessionsListView', props),
    // The list draws its own title row; an empty body it is given stands in for its rows.
    SessionsListViewWithFilterController: (props: any) => React.createElement('SessionsListViewWithFilterController', props, props.emptyBody ?? null),
}));

vi.mock('@/components/sessions/shell/SessionsListEmptyState', () => ({
    SessionsListEmptyState: (props: any) => React.createElement('SessionsListEmptyState', props),
}));

vi.mock('@/components/sessions/shell/ExternalSessionsEmptyState', () => ({
    ExternalSessionsEmptyState: (props: any) => React.createElement('ExternalSessionsEmptyState', props),
}));
vi.mock('@/components/sessions/shell/HiddenInactiveSessionsEmptyState', () => ({
    HiddenInactiveSessionsEmptyState: (props: any) => React.createElement('HiddenInactiveSessionsEmptyState', props),
}));

// Collect the real module graph before timing the rendered loading-state contracts.
const { SessionsListPaneContent } = await import('./SessionsListPaneContent');

describe('SessionsListPaneContent (loading)', () => {
    beforeEach(() => {
        sessionListState.calls = 0;
        sessionListState.callOptions = [];
        filterControllerState.controller.filters.source = 'all';
        filterControllerState.controller.queryEnabled = true;
    });

    it('passes the already resolved pane state into the rendered session list', async () => {
        sessionListState.paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListViewData: [{ type: 'session', session: { id: 'session-1' } }] as any[],
            hasHiddenInactiveSessions: false,
            showLoading: false,
            showEmptyState: false,
        };

        const screen = await renderScreen(
            <SessionsListPaneContent fallbackGuidanceVariant="sidebar" />,
            {
                flushOptions: { cycles: 0 },
            },
        );

        const list = screen.findByType('SessionsListViewWithFilterController' as any);
        expect(list.props.paneState).toBe(sessionListState.paneState);
        expect(sessionListState.calls).toBe(1);
    });

    it('uses the retained filter controller query when resolving the global pane', async () => {
        const screen = await renderScreen(
            <SessionsListPaneContent fallbackGuidanceVariant="sidebar" />,
            { flushOptions: { cycles: 0 } },
        );

        expect(sessionListState.callOptions).toEqual([
            expect.objectContaining({
                queryHomes: filterControllerState.controller.pagingHomes,
            }),
        ]);
        expect(screen.findByType('SessionsListViewWithFilterController' as any).props.filterController)
            .toBe(filterControllerState.controller);
    });

    it('holds the list shape with skeleton rows while the canonical session summary is not ready', async () => {
        sessionListState.calls = 0;
        sessionListState.paneState = {
            summary: {
                sessionsReady: false,
                sessionCount: 0,
            },
            visibleSessionListViewData: [{ type: 'session', session: { id: 'session-1' } }] as any[],
            hasHiddenInactiveSessions: false,
            showLoading: true,
            showEmptyState: false,
        };

        const screen = await renderScreen(
            <SessionsListPaneContent fallbackGuidanceVariant="sidebar" />,
            {
                flushOptions: { cycles: 0 },
            },
        );

        expect(screen.findByTestId('session-list-skeleton')).toBeTruthy();
        expect(screen.findAllByType('ActivitySpinner' as any)).toHaveLength(0);
        expect(screen.findAllByType('SessionsListViewWithFilterController' as any)).toHaveLength(0);
    });

    it('uses the canonical session summary to decide empty state even when raw visible rows are still present', async () => {
        filterControllerState.controller.filters.source = 'direct';
        filterControllerState.controller.queryEnabled = false;
        sessionListState.paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 0,
            },
            visibleSessionListViewData: [{ type: 'session', session: { id: 'session-1' } }] as any[],
            hasHiddenInactiveSessions: false,
            showLoading: false,
            showEmptyState: true,
        };

        const screen = await renderScreen(
            <SessionsListPaneContent fallbackGuidanceVariant="sidebar" />,
        );

        expect(screen.findByType('ExternalSessionsEmptyState' as any)).toBeTruthy();
    });

    it('shows the hidden inactive sessions empty state when the inactive filter hides every persisted session', async () => {
        filterControllerState.controller.filters.source = 'persisted';
        filterControllerState.controller.queryEnabled = false;
        sessionListState.paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 0,
            },
            visibleSessionListViewData: [],
            showLoading: false,
            showEmptyState: true,
            hasHiddenInactiveSessions: true,
        };

        const screen = await renderScreen(
            <SessionsListPaneContent fallbackGuidanceVariant="sidebar" />,
        );

        expect(screen.findByType('HiddenInactiveSessionsEmptyState' as any)).toBeTruthy();
    });

    it('keeps an empty sidebar column under its own title row: the list stays, its rows under the title, the empty state inside it (owner 1208 #08)', async () => {
        filterControllerState.controller.filters.source = 'persisted';
        sessionListState.paneState = {
            summary: { sessionsReady: true, sessionCount: 0 },
            visibleSessionListViewData: [],
            hasHiddenInactiveSessions: false,
            showLoading: false,
            showEmptyState: true,
        };
        const leading = React.createElement('ColumnRows');

        const screen = await renderScreen(
            <SessionsListPaneContent fallbackGuidanceVariant="sidebar" leading={leading} />,
        );

        const list = screen.findByType('SessionsListViewWithFilterController' as any);
        expect(list.props.paneState).toBe(sessionListState.paneState);
        expect(list.props.leading).toBe(leading);
        // The first-run state is the list's body, under its title and the column's rows, never a page without them.
        expect(list.findByType('SessionsListEmptyState' as any)).toBeTruthy();
        expect(screen.findAllByType('ColumnRows' as any)).toHaveLength(0);
    });
});
