import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    paneState: {
        summary: {
            sessionsReady: false,
            sessionCount: 0,
        },
        visibleSessionListViewData: [{ type: 'session', session: { id: 'session-1' } }] as any[],
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
    useVisibleSessionListPaneState: () => sessionListState.paneState,
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

vi.mock('@/components/sessions/shell/DirectSessionsEmptyState', () => ({
    DirectSessionsEmptyState: (props: any) => React.createElement('DirectSessionsEmptyState', props),
}));

describe('SessionsListPaneContent (loading)', () => {
    it('shows the loading indicator while the canonical session summary is not ready', async () => {
        const { SessionsListPaneContent } = await import('./SessionsListPaneContent');
        const screen = await renderScreen(
            <SessionsListPaneContent storageKind="persisted" fallbackGuidanceVariant="sidebar" />,
        );

        expect(screen.findByType('ActivityIndicator' as any)).toBeTruthy();
        expect(screen.findAllByType('SessionsListView' as any)).toHaveLength(0);
    });

    it('uses the canonical session summary to decide empty state even when raw visible rows are still present', async () => {
        sessionListState.paneState = {
            summary: {
                sessionsReady: true,
                sessionCount: 0,
            },
            visibleSessionListViewData: [{ type: 'session', session: { id: 'session-1' } }] as any[],
            showLoading: false,
            showEmptyState: true,
        };

        const { SessionsListPaneContent } = await import('./SessionsListPaneContent');
        const screen = await renderScreen(
            <SessionsListPaneContent storageKind="direct" fallbackGuidanceVariant="sidebar" />,
        );

        expect(screen.findByType('DirectSessionsEmptyState' as any)).toBeTruthy();
        expect(screen.findAllByType('SessionsListView' as any)).toHaveLength(0);
    });
});
