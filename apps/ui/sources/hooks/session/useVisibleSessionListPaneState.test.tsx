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
        summary: {
            sessionsReady: true,
            sessionCount: 1,
        },
    }),
}));

vi.mock('./useVisibleSessionListViewState', () => ({
    useVisibleSessionListViewState: () => ({
        visibleSessionListIndex: sessionListPaneState.visibleIndex,
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
            showLoading: false,
            showEmptyState: false,
        });
    });
});
