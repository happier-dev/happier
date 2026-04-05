import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

const sourceState = vi.hoisted(() => ({
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'srv-a',
        allowedServerIds: ['srv-a', 'srv-b'],
        explicit: false,
        activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
    } as any,
    activeData: [
        {
            type: 'session',
            session: {
                id: 'active-1',
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
    ] as ReadonlyArray<SessionListViewItem>,
    byServerId: {
        'srv-a': [
            {
                type: 'session',
                session: {
                    id: 'active-1',
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
        'srv-b': [
            {
                type: 'session',
                session: {
                    id: 'cached-1',
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
                serverId: 'srv-b',
                serverName: 'Server B',
            },
        ] as ReadonlyArray<SessionListViewItem>,
    } as Record<string, ReadonlyArray<SessionListViewItem>>,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListViewData: () => sourceState.activeData,
            useServerScopedSessionListCache: () => sourceState.byServerId,
        },
    });
});

vi.mock('./useSessionListSelectionState', () => ({
    useSessionListSelectionState: () => sourceState.selection,
}));

describe('useVisibleSessionListSourceState', () => {
    afterEach(() => {
        standardCleanup();
        sourceState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a', 'srv-b'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
        };
        sourceState.activeData = [
            {
                type: 'session',
                session: {
                    id: 'active-1',
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
        ];
        sourceState.byServerId = {
            'srv-a': [
                {
                    type: 'session',
                    session: {
                        id: 'active-1',
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
            'srv-b': [
                {
                    type: 'session',
                    session: {
                        id: 'cached-1',
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
                    serverId: 'srv-b',
                    serverName: 'Server B',
                },
            ],
        };
    });

    it('returns the canonical selection together with the resolved visible source', async () => {
        const { useVisibleSessionListSourceState } = await import('./useVisibleSessionListSourceState');
        const hook = await renderHook(() => useVisibleSessionListSourceState());
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            selection: sourceState.selection,
            source: expect.arrayContaining([
                expect.objectContaining({ serverId: 'srv-a' }),
                expect.objectContaining({ serverId: 'srv-b' }),
            ]),
        }));
        expect(hook.getCurrent()?.source?.map((item) => item.type === 'session' ? item.session.id : item.type)).toEqual(['active-1', 'cached-1']);
    });
});
