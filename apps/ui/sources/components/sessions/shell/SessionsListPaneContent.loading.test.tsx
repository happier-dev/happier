import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    calls: 0,
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

installSessionShellCommonModuleMocks({
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
    useVisibleSessionListPaneState: () => {
        sessionListState.calls += 1;
        return sessionListState.paneState;
    },
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
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props),
}));

describe('SessionsListPaneContent (loading)', () => {
    it('passes the already resolved pane state into the rendered session list', async () => {
        sessionListState.calls = 0;
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

        const { SessionsListPaneContent } = await import('./SessionsListPaneContent');
        const screen = await renderScreen(
            <SessionsListPaneContent storageKind="persisted" fallbackGuidanceVariant="sidebar" />,
            {
                flushOptions: { cycles: 0 },
            },
        );

        const list = screen.findByType('SessionsListView' as any);
        expect(list.props.paneState).toBe(sessionListState.paneState);
        expect(sessionListState.calls).toBe(1);
    });

    it('shows the loading indicator while the canonical session summary is not ready', async () => {
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

        const { SessionsListPaneContent } = await import('./SessionsListPaneContent');
        const screen = await renderScreen(
            <SessionsListPaneContent storageKind="persisted" fallbackGuidanceVariant="sidebar" />,
            {
                flushOptions: { cycles: 0 },
            },
        );

        expect(screen.findByType('ActivitySpinner' as any)).toBeTruthy();
        expect(screen.findAllByType('SessionsListView' as any)).toHaveLength(0);
    });

    it('uses the canonical session summary to decide empty state even when raw visible rows are still present', async () => {
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

        const { SessionsListPaneContent } = await import('./SessionsListPaneContent');
        const screen = await renderScreen(
            <SessionsListPaneContent storageKind="direct" fallbackGuidanceVariant="sidebar" />,
        );

        expect(screen.findByType('ExternalSessionsEmptyState' as any)).toBeTruthy();
        expect(screen.findAllByType('SessionsListView' as any)).toHaveLength(0);
    });

    it('shows the hidden inactive sessions empty state when the inactive filter hides every persisted session', async () => {
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

        const { SessionsListPaneContent } = await import('./SessionsListPaneContent');
        const screen = await renderScreen(
            <SessionsListPaneContent storageKind="persisted" fallbackGuidanceVariant="sidebar" />,
        );

        expect(screen.findByType('HiddenInactiveSessionsEmptyState' as any)).toBeTruthy();
        expect(screen.findAllByType('SessionsListView' as any)).toHaveLength(0);
    });
});
