import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import {
    buildSessionListReachabilityRenderableKey,
    useAllSessionListAttentionRows,
    useAllSessionListRenderables,
    usePersistProjectLastMobileSurface,
    usePersistSessionLastMobileSurface,
    useProjectLastMobileSurface,
    useSessionLastMobileSurface,
    useSessionFolderAssignment,
    useSessionFolderAssignmentsBySessionKey,
    useSessionListRenderableWithServerScope,
    useSessionListIndexByServerId,
    useSessionListReachabilityRenderablesForItems,
    useSessionListRowRenderablesForItems,
    useSessionListRowStateByServerId,
    useSessionServerId,
    useMachine,
    useSessions,
} from '@/sync/domains/state/storage';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

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

describe('useAllSessionListAttentionRows', () => {
    it('prefers scoped row state over active-list renderables for the active server', async () => {
        const previousState = storage.getState();
        try {
            const staleActiveRenderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                updatedAt: 1,
                hasUnreadMessages: false,
            };
            const scopedRenderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                updatedAt: 2,
                hasUnreadMessages: true,
            };

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessionListRenderables: {
                    'session-1': staleActiveRenderable,
                },
                sessionListRowStateByServerId: {
                    'active-server': {
                        'session-1': scopedRenderable,
                    },
                },
            }));

            const hook = await renderHook(() => useAllSessionListAttentionRows(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual([{
                serverId: 'active-server',
                serverName: null,
                session: scopedRenderable,
            }]);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useSessionServerId', () => {
    it('does not subscribe to storage while disabled', async () => {
        const subscribeSpy = vi.spyOn(storage, 'subscribe');
        try {
            const hook = await renderHook(
                (enabled: boolean) => useSessionServerId('session-1', enabled),
                { initialProps: false },
            );

            expect(hook.getCurrent()).toBeNull();
            expect(subscribeSpy).not.toHaveBeenCalled();

            await hook.rerender(true);
            expect(subscribeSpy).toHaveBeenCalledTimes(1);

            await hook.rerender(false);
            expect(hook.getCurrent()).toBeNull();

            await hook.unmount();
            expect(subscribeSpy).toHaveBeenCalledTimes(1);
        } finally {
            subscribeSpy.mockRestore();
        }
    });

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

describe('useMachine', () => {
    it('subscribes only when its consumer enables the machine target', async () => {
        const subscribeSpy = vi.spyOn(storage, 'subscribe');
        try {
            const hook = await renderHook(
                (enabled: boolean) => useMachine('machine-1', enabled),
                { initialProps: false },
            );

            expect(hook.getCurrent()).toBeNull();
            expect(subscribeSpy).not.toHaveBeenCalled();

            await hook.rerender(true);
            expect(subscribeSpy).toHaveBeenCalledTimes(1);

            await hook.rerender(false);
            expect(hook.getCurrent()).toBeNull();

            await hook.unmount();
            expect(subscribeSpy).toHaveBeenCalledTimes(1);
        } finally {
            subscribeSpy.mockRestore();
        }
    });
});

describe('session folder assignment selectors', () => {
    it('read from the canonical session organization assignment map', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessionOrganizationFolderAssignmentsBySessionKey: {
                    'server-a:session-1': 'folder-canonical',
                },
                sessionFolderAssignmentsBySessionKey: {
                    'server-a:session-1': 'folder-stale',
                },
            }));

            const hook = await renderHook(() => ({
                assignment: useSessionFolderAssignment('server-a', 'session-1'),
                assignments: useSessionFolderAssignmentsBySessionKey(),
            }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().assignment).toBe('folder-canonical');
            expect(hook.getCurrent().assignments).toEqual({
                'server-a:session-1': 'folder-canonical',
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useSessionListIndexByServerId', () => {
    it('returns canonical index rows when requested by an equivalent server identity alias', async () => {
        const previousState = storage.getState();
        try {
            const profile = upsertServerProfile({
                serverUrl: 'https://session-index.example.test',
                name: 'Session Index',
                source: 'manual',
            });
            setServerProfileIdentityForUrl(profile.serverUrl, 'srv_session_index');
            const indexItem: SessionListIndexItem = {
                type: 'session',
                sessionId: 'session-1',
                serverId: profile.id,
                serverName: 'Session Index',
            };
            storage.setState((state) => ({
                ...state,
                sessionListIndexByServerId: {
                    [profile.id]: [indexItem],
                },
            }));

            const hook = await renderHook(() => useSessionListIndexByServerId(['srv_session_index']), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual({
                [profile.id]: [indexItem],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('updates mounted server-scoped index and row selectors when a socket-created row is merged', async () => {
        const previousState = storage.getState();
        try {
            const olderRenderable = makeRenderable('older-session');
            const socketRenderable = {
                ...makeRenderable('socket-created-session'),
                active: true,
                activeAt: 10,
                createdAt: 10,
                updatedAt: 20,
                metadata: { path: '/tmp/socket-created-session', host: 'localhost' },
                presence: 'online',
            } satisfies SessionListRenderableSession;

            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRenderables: {},
                sessionListRowStateByServerId: {},
                sessionListIndexByServerId: {},
                concurrentSessionListCacheByServerId: {},
            }));
            storage.getState().replaceSessionListRenderables([olderRenderable]);

            const hook = await renderHook(() => ({
                indexByServerId: useSessionListIndexByServerId(['active-server']),
                rowsByServerId: useSessionListRowStateByServerId(),
            }), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent().indexByServerId['active-server']?.some((item) => (
                item.type === 'session' && item.sessionId === 'socket-created-session'
            ))).toBe(false);
            expect(hook.getCurrent().rowsByServerId['active-server']?.['socket-created-session']).toBeUndefined();

            await act(async () => {
                storage.getState().mergeSessionListRenderables([socketRenderable]);
            });

            expect(hook.getCurrent().indexByServerId['active-server']?.some((item) => (
                item.type === 'session' && item.sessionId === 'socket-created-session'
            ))).toBe(true);
            expect(hook.getCurrent().rowsByServerId['active-server']?.['socket-created-session']).toBe(socketRenderable);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('mobile cockpit surface local-setting selectors', () => {
    it('selects only the requested session last mobile surface', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...state.localSettings,
                    sessionLastMobileSurfaceBySessionId: {
                        'session-1': 'git',
                        'session-2': 'terminal',
                    },
                },
            }));

            const hook = await renderHook(() => useSessionLastMobileSurface('session-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toBe('git');

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    localSettings: {
                        ...state.localSettings,
                        sessionLastMobileSurfaceBySessionId: {
                            ...state.localSettings.sessionLastMobileSurfaceBySessionId,
                            'session-2': 'chat',
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe('git');
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('prefers the server-scoped session last mobile surface when the server id is known locally', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...state.localSettings,
                    sessionLastMobileSurfaceBySessionId: {
                        'session-1': 'git',
                        'active-server:session-1': 'terminal',
                    },
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

            const hook = await renderHook(() => useSessionLastMobileSurface('session-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe('terminal');

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('persists a session last mobile surface by merging the current map', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...state.localSettings,
                    sessionLastMobileSurfaceBySessionId: {
                        existing: 'git',
                    },
                },
            }));

            const hook = await renderHook(() => usePersistSessionLastMobileSurface(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            await act(async () => {
                hook.getCurrent()('session-1', 'chat');
            });

            expect(storage.getState().localSettings.sessionLastMobileSurfaceBySessionId).toEqual({
                existing: 'git',
                'session-1': 'chat',
            });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('persists a server-scoped session last mobile surface when the server id is known locally', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...state.localSettings,
                    sessionLastMobileSurfaceBySessionId: {
                        existing: 'git',
                    },
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

            const hook = await renderHook(() => usePersistSessionLastMobileSurface(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            await act(async () => {
                hook.getCurrent()('session-1', 'chat');
            });

            expect(storage.getState().localSettings.sessionLastMobileSurfaceBySessionId).toEqual({
                existing: 'git',
                'active-server:session-1': 'chat',
            });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('selects and persists project last mobile surfaces by workspace ref', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...state.localSettings,
                    projectLastMobileSurfaceByWorkspaceRefId: {
                        wr_1: 'git',
                        wr_2: 'terminal',
                    },
                },
            }));

            const selectedHook = await renderHook(() => useProjectLastMobileSurface('wr_1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(selectedHook.getCurrent()).toBe('git');

            const persistHook = await renderHook(() => usePersistProjectLastMobileSurface(), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            await act(async () => {
                persistHook.getCurrent()('wr_3', 'overview');
            });

            expect(selectedHook.getCurrent()).toBe('git');
            expect(storage.getState().localSettings.projectLastMobileSurfaceByWorkspaceRefId).toEqual({
                wr_1: 'git',
                wr_2: 'terminal',
                wr_3: 'overview',
            });
            await selectedHook.unmount();
            await persistHook.unmount();
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

            expect(hook.getCurrent()).toEqual(expect.objectContaining({
                id: renderable.id,
                metadata: renderable.metadata,
            }));

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

            expect(hook.getCurrent()).toEqual(expect.objectContaining({
                id: renderable.id,
                metadata: renderable.metadata,
            }));

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('preserves read-state fields on projected row renderables', async () => {
        const previousState = storage.getState();
        try {
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 7,
                lastViewedSessionSeq: 7,
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

            expect(hook.getCurrent()).toEqual(expect.objectContaining({
                seq: 7,
                lastViewedSessionSeq: 7,
            }));

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps scoped row renderables stable when only streaming version counters change', async () => {
        const previousState = storage.getState();
        try {
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 10,
                lastViewedSessionSeq: 10,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                pendingVersion: 1,
                metadata: { path: '/repo', machineId: 'm-1', host: 'localhost' },
                metadataVersion: 1,
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: 2,
                presence: 'online',
            };

            storage.setState((state) => ({
                ...state,
                sessionListRenderables: {
                    'session-1': renderable,
                },
                sessionListRowStateByServerId: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(
                () => {
                    renderCount += 1;
                    return useSessionListRenderableWithServerScope(null, 'session-1');
                },
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const initial = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        'session-1': {
                            ...renderable,
                            updatedAt: 3,
                            pendingVersion: 2,
                            metadataVersion: 2,
                            agentStateVersion: 2,
                            thinkingAt: 3,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(initial);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps active online scoped row renderables stable when only activeAt changes', async () => {
        const previousState = storage.getState();
        try {
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 10,
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

            let renderCount = 0;
            const hook = await renderHook(
                () => {
                    renderCount += 1;
                    return useSessionListRenderableWithServerScope(null, 'session-1');
                },
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const initial = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        'session-1': {
                            ...renderable,
                            activeAt: 3,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(initial);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps row renderable maps stable for fresh progress-only timestamp advances', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const previousState = storage.getState();
        try {
            const rowItems: SessionListIndexItem[] = [{
                type: 'session',
                sessionId: 'session-1',
                serverId: 'server-1',
                groupKey: 'group-1',
                groupKind: 'date',
            }];
            const renderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 10,
                lastViewedSessionSeq: 10,
                createdAt: 1,
                updatedAt: Date.now() - 5_000,
                meaningfulActivityAt: Date.now() - 5_000,
                active: true,
                activeAt: Date.now() - 5_000,
                metadata: { path: '/repo', machineId: 'm-1', host: 'localhost' },
                metadataVersion: 1,
                agentStateVersion: 1,
                presence: 'online',
                latestTurnStatus: 'in_progress',
                hasUnreadMessages: true,
            };

            storage.setState((state) => ({
                ...state,
                sessionListRenderables: {},
                sessionListRowStateByServerId: {
                    'server-1': {
                        'session-1': renderable,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(
                () => {
                    renderCount += 1;
                    return useSessionListRowRenderablesForItems(rowItems);
                },
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const rowKey = buildSessionListReachabilityRenderableKey('server-1', 'session-1');
            expect(rowKey).toBeTruthy();
            const initial = hook.getCurrent();
            const initialRenderable = initial.get(rowKey!);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        'server-1': {
                            'session-1': {
                                ...renderable,
                                seq: 11,
                                updatedAt: renderable.updatedAt + 5_000,
                                meaningfulActivityAt: (renderable.meaningfulActivityAt ?? renderable.updatedAt) + 5_000,
                            },
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(initial);
            expect(hook.getCurrent().get(rowKey!)).toBe(initialRenderable);
            expect(renderCount).toBe(1);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        'server-1': {
                            'session-1': {
                                ...renderable,
                                seq: 12,
                                updatedAt: renderable.updatedAt + 31_000,
                                meaningfulActivityAt: (renderable.meaningfulActivityAt ?? renderable.updatedAt) + 31_000,
                            },
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).not.toBe(initial);
            expect(hook.getCurrent().get(rowKey!)).not.toBe(initialRenderable);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            storage.setState(previousState);
        }
    });

    it('keeps duplicate session ids scoped by server for progress-only row projection reuse', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
        const previousState = storage.getState();
        try {
            const rowItems: SessionListIndexItem[] = [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    groupKey: 'group-1',
                    groupKind: 'date',
                },
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-2',
                    groupKey: 'group-1',
                    groupKind: 'date',
                },
            ];
            const serverOneRenderable: SessionListRenderableSession = {
                ...makeRenderable('session-1'),
                seq: 10,
                lastViewedSessionSeq: 10,
                createdAt: 1,
                updatedAt: Date.now() - 5_000,
                meaningfulActivityAt: Date.now() - 5_000,
                active: true,
                activeAt: Date.now() - 5_000,
                metadata: { path: '/repo-one', machineId: 'm-1', host: 'localhost' },
                metadataVersion: 1,
                agentStateVersion: 1,
                presence: 'online',
                latestTurnStatus: 'in_progress',
                hasUnreadMessages: true,
            };
            const serverTwoRenderable: SessionListRenderableSession = {
                ...serverOneRenderable,
                metadata: { path: '/repo-two', machineId: 'm-2', host: 'localhost' },
            };

            storage.setState((state) => ({
                ...state,
                sessionListRenderables: {},
                sessionListRowStateByServerId: {
                    'server-1': {
                        'session-1': serverOneRenderable,
                    },
                    'server-2': {
                        'session-1': serverTwoRenderable,
                    },
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(
                () => {
                    renderCount += 1;
                    return useSessionListRowRenderablesForItems(rowItems);
                },
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const serverOneKey = buildSessionListReachabilityRenderableKey('server-1', 'session-1');
            const serverTwoKey = buildSessionListReachabilityRenderableKey('server-2', 'session-1');
            expect(serverOneKey).toBeTruthy();
            expect(serverTwoKey).toBeTruthy();
            const initial = hook.getCurrent();
            const initialServerOneRenderable = initial.get(serverOneKey!);
            const initialServerTwoRenderable = initial.get(serverTwoKey!);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowStateByServerId: {
                        'server-1': {
                            'session-1': {
                                ...serverOneRenderable,
                                seq: 11,
                                updatedAt: serverOneRenderable.updatedAt + 5_000,
                                meaningfulActivityAt: (serverOneRenderable.meaningfulActivityAt ?? serverOneRenderable.updatedAt) + 5_000,
                            },
                        },
                        'server-2': {
                            'session-1': serverTwoRenderable,
                        },
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(initial);
            expect(hook.getCurrent().get(serverOneKey!)).toBe(initialServerOneRenderable);
            expect(hook.getCurrent().get(serverTwoKey!)).toBe(initialServerTwoRenderable);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            vi.useRealTimers();
            storage.setState(previousState);
        }
    });

    it('resolves row renderables through equivalent server identity aliases', async () => {
        const previousState = storage.getState();
        try {
            const profile = upsertServerProfile({
                serverUrl: 'https://row-alias.example.test',
                name: 'Row Alias',
                source: 'manual',
            });
            setServerProfileIdentityForUrl(profile.serverUrl, 'srv_row_alias');
            const rowItems: SessionListIndexItem[] = [{
                type: 'session',
                sessionId: 'session-1',
                serverId: 'srv_row_alias',
                groupKey: 'group-1',
                groupKind: 'date',
            }];
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
                    [profile.id]: {
                        'session-1': renderable,
                    },
                },
            }));

            const rowHook = await renderHook(
                () => useSessionListRowRenderablesForItems(rowItems),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const reachabilityHook = await renderHook(
                () => useSessionListReachabilityRenderablesForItems(rowItems),
                { flushOptions: { cycles: 1, turns: 4 } },
            );

            const rowKey = buildSessionListReachabilityRenderableKey('srv_row_alias', 'session-1');
            expect(rowKey).toBeTruthy();

            expect(rowHook.getCurrent().get(rowKey!)).toEqual(expect.objectContaining({
                id: 'session-1',
                metadata: renderable.metadata,
            }));
            expect(reachabilityHook.getCurrent().get('srv_row_alias\u0000session-1')).toEqual(expect.objectContaining({
                id: 'session-1',
                metadata: renderable.metadata,
            }));

            await rowHook.unmount();
            await reachabilityHook.unmount();
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

            expect(hook.getCurrent()).toEqual(expect.objectContaining({
                id: renderable.id,
                metadata: renderable.metadata,
            }));

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
