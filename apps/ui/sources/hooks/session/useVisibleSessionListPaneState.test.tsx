import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const sessionListPaneState = vi.hoisted(() => ({
    viewStateCalls: [] as Array<{ storageFilter: string; pathname: string | null; sessionListSurfaceDataActive: boolean | null }>,
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
    folderFocus: null as null | { folderId: string },
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
    useVisibleSessionListViewState: (storageFilter?: string, options?: { pathname?: string; sessionListSurfaceDataActive?: boolean }) => {
        sessionListPaneState.viewStateCalls.push({
            storageFilter: storageFilter ?? 'all',
            pathname: options?.pathname ?? null,
            sessionListSurfaceDataActive: options?.sessionListSurfaceDataActive ?? null,
        });
        return {
        visibleSessionListIndex: sessionListPaneState.visibleIndex,
        hasHiddenInactiveSessions: sessionListPaneState.hasHiddenInactiveSessions,
        folderFocus: sessionListPaneState.folderFocus,
        };
    },
}));

describe('useVisibleSessionListPaneState', () => {
    afterEach(() => {
        standardCleanup();
        sessionListPaneState.viewStateCalls = [];
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
        sessionListPaneState.folderFocus = null;
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
            folderFocus: null,
            showLoading: false,
            showEmptyState: false,
        });
    });

    it('forwards an explicit pathname override to the visible view-state owner', async () => {
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('direct', { pathname: '/' }));
        await flushHookEffects();

        expect(hook.getCurrent().visibleSessionListIndex).toEqual(sessionListPaneState.visibleIndex);
        expect(sessionListPaneState.viewStateCalls).toEqual([
            { storageFilter: 'direct', pathname: '/', sessionListSurfaceDataActive: null },
        ]);
    });

    it('forwards the surface data-active flag to the visible view-state owner', async () => {
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('direct', {
            pathname: '/',
            sessionListSurfaceDataActive: false,
        }));
        await flushHookEffects();

        expect(hook.getCurrent().visibleSessionListIndex).toEqual(sessionListPaneState.visibleIndex);
        expect(sessionListPaneState.viewStateCalls).toEqual([
            { storageFilter: 'direct', pathname: '/', sessionListSurfaceDataActive: false },
        ]);
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
