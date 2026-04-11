import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const sessionListPaneState = vi.hoisted(() => ({
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 's1',
        allowedServerIds: ['s1'],
        explicit: false,
        activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
    },
    visibleIndex: [
        { type: 'session', sessionId: 'session-1', serverId: 's1', serverName: 'Server 1' },
    ],
    summary: {
        sessionsReady: true,
        sessionCount: 1,
    },
    hasHiddenInactiveSessions: false,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
        },
    });
});

vi.mock('./useVisibleSessionListSummaryState', () => ({
    useVisibleSessionListSummaryState: () => ({
        selection: sessionListPaneState.selection,
        summary: sessionListPaneState.summary,
    }),
}));

vi.mock('./useVisibleSessionListViewState', () => ({
    useVisibleSessionListViewState: () => ({
        visibleSessionListIndex: sessionListPaneState.visibleIndex,
        hasHiddenInactiveSessions: sessionListPaneState.hasHiddenInactiveSessions,
    }),
}));

describe('useVisibleSessionListPaneState', () => {
    afterEach(() => {
        standardCleanup();
        sessionListPaneState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        sessionListPaneState.visibleIndex = [
            { type: 'session', sessionId: 'session-1', serverId: 's1', serverName: 'Server 1' },
        ];
        sessionListPaneState.summary = {
            sessionsReady: true,
            sessionCount: 1,
        };
        sessionListPaneState.hasHiddenInactiveSessions = false;
    });

    it('returns combined loading and empty-state flags from the canonical summary', async () => {
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual({
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListIndex: expect.arrayContaining([
                expect.objectContaining({
                    type: 'session',
                    sessionId: 'session-1',
                }),
            ]),
            hasHiddenInactiveSessions: false,
            showLoading: false,
            showEmptyState: false,
        });
    });

    it('treats the pane as empty when filtering removes all visible session rows even if the upstream summary still counted sessions', async () => {
        sessionListPaneState.summary = {
            sessionsReady: true,
            sessionCount: 1,
        };
        sessionListPaneState.visibleIndex = [];
        sessionListPaneState.hasHiddenInactiveSessions = true;

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent().showLoading).toBe(false);
        expect(hook.getCurrent().showEmptyState).toBe(true);
        expect(hook.getCurrent().hasHiddenInactiveSessions).toBe(true);
    });
});
