import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useAllSessionListRenderables, useSessionServerId, useSessions } from '@/sync/domains/state/storage';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

function makeSessionListItem(id: string, serverId: string, serverName: string): SessionListViewItem {
    return {
        type: 'session',
        serverId,
        serverName,
        session: {
            id,
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: null,
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        },
    };
}

describe('useSessions', () => {
    it('returns sessions from the canonical sessions map', async () => {
        const previousState = storage.getState();
        try {
            const session = {
                id: 's-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { path: '/repo', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any;

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { 's-1': session },
            }));

            const hook = await renderHook(() => useSessions(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([session]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useAllSessionListRenderables', () => {
    it('returns renderables from the canonical renderables map instead of full sessions', async () => {
        const previousState = storage.getState();
        try {
            const renderable = {
                id: 's-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { path: '/repo', machineId: 'm-1' },
                metadataVersion: 1,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any;

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: { 's-1': renderable },
            }));

            const hook = await renderHook(() => useAllSessionListRenderables(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([renderable]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useSessionServerId', () => {
    it('falls back to the active-list cache when the canonical sessions map has not hydrated yet', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {},
                sessionListViewData: [
                    makeSessionListItem('session-1', 'active-server', 'Current server'),
                ],
                sessionListViewDataByServerId: {
                    'side-server': [
                        makeSessionListItem('session-1', 'side-server', 'Background server'),
                    ],
                },
            }));

            const hook = await renderHook(() => useSessionServerId('session-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe('active-server');

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
