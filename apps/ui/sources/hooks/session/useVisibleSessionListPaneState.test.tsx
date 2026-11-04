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
    summary: {
        sessionsReady: true,
        sessionCount: 1,
    },
    hasHiddenInactiveSessions: false,
    query: undefined as undefined | {
        active: true;
        statesByServerId: Record<string, unknown>;
        coverageComplete: boolean;
    },
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
        filterResult: { matchedCount: sessionListPaneState.visibleIndex.length, coverage: 'complete' },
        hasHiddenInactiveSessions: sessionListPaneState.hasHiddenInactiveSessions,
        query: sessionListPaneState.query,
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
        sessionListPaneState.summary = {
            sessionsReady: true,
            sessionCount: 1,
        };
        sessionListPaneState.hasHiddenInactiveSessions = false;
        sessionListPaneState.query = undefined;
    });

    it('returns combined loading and empty-state flags from the canonical summary', async () => {
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent()).toMatchObject({
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
            filterResult: { matchedCount: 1, coverage: 'complete' },

            showLoading: false,
            showEmptyState: false,
            query: undefined,
            queryPresentation: undefined,
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

    it('keeps a partial zero query in the canonical list surface instead of showing onboarding', async () => {
        sessionListPaneState.visibleIndex = [];
        sessionListPaneState.query = {
            active: true,
            statesByServerId: {
                'home-a': {
                    requestedQueryKey: 'query', appliedQueryKey: 'query', addresses: [],
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                    phase: 'ready', freshnessAt: 1, failureReason: null, failureCode: null,
                    homeObservation: { phase: 'ready', lastSuccessAt: 1 },
                },
                'home-b': {
                    requestedQueryKey: 'query', appliedQueryKey: null, addresses: [],
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                    phase: 'offline', freshnessAt: null, failureReason: null, failureCode: null,
                    homeObservation: { phase: 'offline', lastSuccessAt: null },
                },
            },
            coverageComplete: false,
        };

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', {
            queryHomes: [
                { serverId: 'home-a', queryKey: 'query', query: {} as never },
                { serverId: 'home-b', queryKey: 'query', query: {} as never },
            ],
        }));
        await flushHookEffects();

        expect(hook.getCurrent().queryPresentation).toEqual({
            kind: 'partial',
            unavailableHomes: [{ serverId: 'home-b', reason: 'offline' }],
        });
        expect(hook.getCurrent().showLoading).toBe(false);
        expect(hook.getCurrent().showEmptyState).toBe(false);
        expect(hook.getCurrent().filterResult).toEqual({ matchedCount: 0, coverage: 'partial' });
    });

    it('keeps initial query loading inside the mounted canonical list surface', async () => {
        sessionListPaneState.visibleIndex = [];
        sessionListPaneState.query = {
            active: true,
            statesByServerId: {
                'home-a': {
                    requestedQueryKey: 'query', appliedQueryKey: null, addresses: [],
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                    phase: 'loading', freshnessAt: null, failureReason: null, failureCode: null,
                    homeObservation: { phase: 'loading', lastSuccessAt: null },
                },
            },
            coverageComplete: false,
        };

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('all', {
            queryHomes: [
                { serverId: 'home-a', queryKey: 'query', query: {} as never },
            ],
        }));
        await flushHookEffects();

        expect(hook.getCurrent().queryPresentation).toEqual({ kind: 'initial_loading' });
        expect(hook.getCurrent().summary).toEqual({ sessionsReady: false, sessionCount: 0 });
        expect(hook.getCurrent().filterResult).toEqual({ matchedCount: 0, coverage: 'unavailable' });
        expect(hook.getCurrent().showLoading).toBe(false);
        expect(hook.getCurrent().showEmptyState).toBe(false);
    });
});
