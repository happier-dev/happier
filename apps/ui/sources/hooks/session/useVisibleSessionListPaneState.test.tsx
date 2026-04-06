import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const sessionListPaneState = vi.hoisted(() => ({
    session: {
        id: 'session-1',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        metadata: {
            path: '',
            directSessionV1: { v: 1 },
        },
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
    },
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 's1',
        allowedServerIds: ['s1'],
        explicit: false,
        activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
    },
    source: [
        { type: 'session', session: {} as Record<string, unknown>, serverId: 's1', serverName: 'Server 1' },
    ] as Array<{ type: 'session'; session: Record<string, unknown>; serverId: string; serverName: string }>,
    activeData: null as any,
    data: null as any,
    byServerId: {
        s1: [
            { type: 'session', session: { id: 'session-1' }, serverId: 's1', serverName: 'Server 1' },
        ],
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

vi.mock('./useVisibleSessionListSourceState', () => ({
    useVisibleSessionListSourceState: () => ({
        selection: sessionListPaneState.selection,
        activeData: sessionListPaneState.activeData,
        byServerId: sessionListPaneState.byServerId,
        source: sessionListPaneState.source,
    }),
}));

vi.mock('./useVisibleSessionListSummaryState', () => ({
    useVisibleSessionListSummaryState: () => ({
        selection: sessionListPaneState.selection,
        summary: {
            sessionsReady: true,
            sessionCount: 1,
        },
    }),
}));

vi.mock('./useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => {
        throw new Error('pane state should resolve visible list data from the canonical source-state path');
    },
}));

vi.mock('@/sync/domains/session/listing/sessionListPresentation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/session/listing/sessionListPresentation')>();
    return {
        ...actual,
        resolveVisibleSessionListSummary: () => {
            throw new Error('pane state should consume the canonical summary-state hook instead of resolving summary directly');
        },
    };
});

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
        sessionListPaneState.source = [
            { type: 'session', session: sessionListPaneState.session as any, serverId: 's1', serverName: 'Server 1' },
        ];
        sessionListPaneState.session = {
            id: 'session-1',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                path: '',
                directSessionV1: { v: 1 },
            },
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        };
        sessionListPaneState.data = [{ type: 'session', session: { id: 'session-1' } }];
        sessionListPaneState.byServerId = {
            s1: [
                { type: 'session', session: sessionListPaneState.session as any, serverId: 's1', serverName: 'Server 1' },
            ],
        };
    });

    it('returns combined loading and empty-state flags from the canonical summary', async () => {
        sessionListPaneState.byServerId = {
            s1: [
                {
                    type: 'session',
                    session: sessionListPaneState.session as any,
                    serverId: 's1',
                    serverName: 'Server 1',
                },
            ],
        };
        sessionListPaneState.source = [
            {
                type: 'session',
                session: sessionListPaneState.session as any,
                serverId: 's1',
                serverName: 'Server 1',
            },
        ];

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const hook = await renderHook(() => useVisibleSessionListPaneState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual({
            summary: {
                sessionsReady: true,
                sessionCount: 1,
            },
            visibleSessionListViewData: expect.arrayContaining([
                expect.objectContaining({
                    type: 'session',
                    session: expect.objectContaining({ id: 'session-1' }),
                }),
            ]),
            showLoading: false,
            showEmptyState: false,
        });
    });
});
