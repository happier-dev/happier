import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const sessionListPaneState = vi.hoisted(() => ({
    summary: {
        sessionsReady: false,
        sessionCount: 0,
    },
    data: null as any,
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
        selection: {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        },
        summary: sessionListPaneState.summary,
    }),
}));

vi.mock('./useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => sessionListPaneState.data,
}));

describe('useVisibleSessionListPaneState', () => {
    afterEach(() => {
        standardCleanup();
        sessionListPaneState.summary = {
            sessionsReady: false,
            sessionCount: 0,
        };
        sessionListPaneState.data = null;
    });

    it('returns combined loading and empty-state flags from the canonical summary', async () => {
        sessionListPaneState.summary = {
            sessionsReady: true,
            sessionCount: 0,
        };
        sessionListPaneState.data = [{ type: 'session', session: { id: 'session-1' } }];

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual({
            summary: {
                sessionsReady: true,
                sessionCount: 0,
            },
            visibleSessionListViewData: sessionListPaneState.data,
            showLoading: false,
            showEmptyState: true,
        });
    });
});
