import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useAllSessionListRenderables, useSessionListRenderableWithServerScope, useSessionServerId, useSessions } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'active-server', serverUrl: 'https://example.com', generation: 1 })));
const activeServerRuntimeState = vi.hoisted(() => ({
    listener: null as null | ((snapshot: { serverId: string; serverUrl: string; generation: number }) => void),
    snapshot: { serverId: 'active-server', serverUrl: 'https://example.com', generation: 1 },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => {
        getActiveServerSnapshotMock();
        return activeServerRuntimeState.snapshot;
    },
    subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        activeServerRuntimeState.listener = listener;
        return () => {
            if (activeServerRuntimeState.listener === listener) {
                activeServerRuntimeState.listener = null;
            }
        };
    },
}));

afterEach(() => {
    activeServerRuntimeState.listener = null;
    activeServerRuntimeState.snapshot = { serverId: 'active-server', serverUrl: 'https://example.com', generation: 1 };
    standardCleanup();
});

function makeRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: { path: '' },
        thinking: false,
        thinkingAt: 0,
        presence: 0,
    } satisfies SessionListRenderableSession;
}

describe('useSessions', () => {
    it('returns sessions from the canonical sessions map', async () => {
        const previousState = storage.getState();
        try {
            const session: Session = {
                id: 's-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { path: '/repo', host: 'localhost', machineId: 'm-1' },
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            };

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
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('s-1'),
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { path: '/repo', machineId: 'm-1', host: 'localhost' },
                metadataVersion: 1,
                presence: 'online',
            };

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
            const renderable = makeRenderable('session-1');
            storage.setState((state) => ({
                ...state,
                sessions: {},
                sessionListRenderables: {
                    'session-1': renderable,
                },
                sessionListIndexByServerId: {
                    'active-server': [
                        {
                            type: 'session',
                            sessionId: 'session-1',
                            serverId: 'active-server',
                            serverName: 'Current server',
                        },
                    ],
                },
                concurrentSessionListCacheByServerId: {
                    'side-server': {
                        serverName: 'Background server',
                        sessions: {
                            'session-1': makeRenderable('session-1'),
                        },
                    },
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

    it('treats padded session ids as canonical when resolving the server id', async () => {
        const previousState = storage.getState();
        try {
            const renderable = makeRenderable('session-1');
            storage.setState((state) => ({
                ...state,
                sessions: {},
                sessionListRenderables: {
                    'session-1': renderable,
                },
                sessionListIndexByServerId: {
                    'active-server': [
                        {
                            type: 'session',
                            sessionId: 'session-1',
                            serverId: 'active-server',
                            serverName: 'Current server',
                        },
                    ],
                },
            }));

            const hook = await renderHook(() => useSessionServerId('  session-1  '), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe('active-server');

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useSessionListRenderableWithServerScope', () => {
    it('resolves renderables from the server-scoped row cache when serverId is provided', async () => {
        const previousState = storage.getState();
        try {
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { path: '/repo', machineId: 'm-1', host: 'localhost' },
                metadataVersion: 1,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                sessionListRenderables: {},
                sessionListRowStateByServerId: {
                    'side-server': {
                        'session-1': renderable,
                    },
                },
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope('side-server', 'session-1'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toBe(renderable);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('falls back to the active renderables map when serverId is missing', async () => {
        const previousState = storage.getState();
        try {
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { path: '/repo', machineId: 'm-1', host: 'localhost' },
                metadataVersion: 1,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                sessionListRenderables: {
                    'session-1': renderable,
                },
                sessionListRowStateByServerId: {},
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope(null, 'session-1'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toBe(renderable);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('drops the active-renderables fallback when the requested server is no longer active', async () => {
        const previousState = storage.getState();
        try {
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { path: '/repo', machineId: 'm-1', host: 'localhost' },
                metadataVersion: 1,
                presence: 'online',
            };

            activeServerRuntimeState.snapshot = {
                serverId: 'side-server',
                serverUrl: 'https://side.example.com',
                generation: 1,
            };

            storage.setState((state) => ({
                ...state,
                sessionListRenderables: {
                    'session-1': renderable,
                },
                sessionListRowStateByServerId: {},
            }));

            const hook = await renderHook(
                () => useSessionListRenderableWithServerScope('side-server', 'session-1'),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            expect(hook.getCurrent()).toBe(renderable);

            await act(async () => {
                activeServerRuntimeState.snapshot = {
                    serverId: 'other-server',
                    serverUrl: 'https://other.example.com',
                    generation: 2,
                };
                activeServerRuntimeState.listener?.(activeServerRuntimeState.snapshot);
            });

            expect(hook.getCurrent()).toBeNull();

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
