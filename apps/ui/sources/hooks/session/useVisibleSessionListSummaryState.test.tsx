import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

const summaryState = vi.hoisted(() => ({
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'srv-a',
        allowedServerIds: ['srv-a'],
        explicit: false,
        activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
    } as any,
    activeData: null as SessionListViewItem[] | null,
    byServerId: {
        'srv-a': [
            {
                type: 'session',
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
                serverId: 'srv-a',
                serverName: 'Server A',
            },
        ] as SessionListViewItem[],
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListViewData: () => summaryState.activeData,
            useServerScopedSessionListCache: () => summaryState.byServerId,
        },
    });
});

vi.mock('./useSessionListSelectionState', () => ({
    useSessionListSelectionState: () => summaryState.selection,
}));

describe('useVisibleSessionListSummaryState', () => {
    afterEach(() => {
        standardCleanup();
        summaryState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
        };
        summaryState.activeData = null;
        summaryState.byServerId = {
            'srv-a': [
                {
                    type: 'session',
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
                    serverId: 'srv-a',
                    serverName: 'Server A',
                },
            ],
        };
    });

    it('returns the canonical summary together with the current selection', async () => {
        const { useVisibleSessionListSummaryState } = await import('./useVisibleSessionListSummaryState');
        const hook = await renderHook(() => useVisibleSessionListSummaryState('direct'));
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            selection: summaryState.selection,
            summary: expect.objectContaining({
                sessionsReady: true,
                sessionCount: 1,
            }),
        }));
    });
});
