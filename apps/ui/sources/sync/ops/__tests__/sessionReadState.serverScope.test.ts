import type { StorageState } from '@/sync/store/types';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockRequest,
    mockResolveContext,
    mockRuntimeFetchWithServerReachability,
    mockStorageState,
    mockActiveServerSnapshot,
} = vi.hoisted(() => ({
    mockRequest: vi.fn(),
    mockResolveContext: vi.fn(),
    mockRuntimeFetchWithServerReachability: vi.fn(),
    mockActiveServerSnapshot: {
        serverId: 'server-a',
        serverUrl: 'https://active.example',
    },
    mockStorageState: {
        sessions: {} as StorageState['sessions'],
        sessionListRenderables: {} as StorageState['sessionListRenderables'],
        sessionListRowStateByServerId: {} as StorageState['sessionListRowStateByServerId'],
        sessionListIndexByServerId: {} as StorageState['sessionListIndexByServerId'],
        concurrentSessionListCacheByServerId: {} as StorageState['concurrentSessionListCacheByServerId'],
        settings: {
            schemaVersion: 1,
            groupInactiveSessionsByProject: false,
            sessionListActiveGroupingV1: 'project',
            sessionListInactiveGroupingV1: 'date',
        } as StorageState['settings'],
        machineListByServerId: {} as StorageState['machineListByServerId'],
        applySessions: vi.fn(),
        applySessionListRenderablePatches: vi.fn(),
        setState: vi.fn((updater: (state: any) => any) => {
            const nextState = updater(mockStorageState as any);
            Object.assign(mockStorageState, nextState);
        }),
    },
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        request: mockRequest,
    },
}));

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext',
    async (importOriginal) =>
        (await import('@/dev/testkit')).createServerScopedSessionContextModuleMock({
            importOriginal,
            overrides: {
                resolveServerScopedSessionContext: mockResolveContext,
            },
        }),
);

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: mockRuntimeFetchWithServerReachability,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => mockActiveServerSnapshot,
}));

vi.mock('@/sync/domains/state/storage', async () =>
    (await import('@/dev/testkit')).createStorageModuleStub({
        storage: {
            getState: () => mockStorageState,
            getInitialState: () => mockStorageState,
            setState: (updater: (state: typeof mockStorageState) => typeof mockStorageState) =>
                mockStorageState.setState(updater),
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    }),
);

import { resetSessionSurfaceVisibilityForTests, setFocusedSessionId } from '../../domains/session/sessionSurfaceVisibility';
import {
    beginSessionViewingActivation,
    resetSessionManualUnreadHoldsForTests,
    shouldSuppressAutomaticMarkViewed,
} from '../../domains/session/readState/sessionManualUnreadHold';
import { sessionSetManualReadStateWithServerScope } from '../../ops';

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
    return {
        ok: opts.ok,
        status: opts.status ?? (opts.ok ? 200 : 500),
        json: async () => opts.json ?? {},
        text: async () => opts.text ?? '',
        headers: new Map(),
    } as any;
}

type TestSession = StorageState['sessions'][string]
    & Omit<SessionListRenderableSession, 'metadata'>
    & { metadata: StorageState['sessions'][string]['metadata'] };

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
    const session: TestSession = {
        id: 'sid-1',
        seq: 7,
        lastViewedSessionSeq: 7,
        createdAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        updatedAt: 100,
        ...overrides,
    };
    return session;
}

describe('sessionSetManualReadStateWithServerScope', () => {
    beforeEach(() => {
        mockRequest.mockReset();
        mockResolveContext.mockReset();
        mockRuntimeFetchWithServerReachability.mockReset();
        mockStorageState.sessions = {};
        mockStorageState.sessionListRenderables = {};
        mockStorageState.sessionListRowStateByServerId = {};
        mockStorageState.sessionListIndexByServerId = {};
        mockStorageState.concurrentSessionListCacheByServerId = {};
        mockStorageState.machineListByServerId = {};
        mockStorageState.applySessions.mockReset();
        mockStorageState.applySessionListRenderablePatches.mockReset();
        mockStorageState.setState.mockClear();
        resetSessionManualUnreadHoldsForTests();
        resetSessionSurfaceVisibilityForTests();
    });

    it('uses active apiSocket.request and applies the returned cursor after success', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession({ lastViewedSessionSeq: 7 }),
        };
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: 6, didChange: true },
        }));

        const res = await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-a' });

        expect(res).toEqual({ success: true, readState: 'unread', lastViewedSessionSeq: 6, didChange: true });
        expect(mockRequest).toHaveBeenCalledWith('/v2/sessions/sid-1/read-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'unread' }),
        });
        expect(mockRuntimeFetchWithServerReachability).not.toHaveBeenCalled();
        expect(mockStorageState.applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'sid-1',
                lastViewedSessionSeq: 6,
                updatedAt: expect.any(Number),
            }),
        ]);
    });

    it('uses runtimeFetchWithServerReachability for a scoped server', async () => {
        mockResolveContext.mockResolvedValue({
            scope: 'scoped',
            targetServerUrl: 'https://scoped.example',
            targetServerId: 'server-b',
            token: 'tok-scoped',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRuntimeFetchWithServerReachability.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'read', lastViewedSessionSeq: 7, didChange: false },
        }));

        const res = await sessionSetManualReadStateWithServerScope('sid-2', 'read', { serverId: 'server-b' });

        expect(res).toEqual({ success: true, readState: 'read', lastViewedSessionSeq: 7, didChange: false });
        expect(mockRuntimeFetchWithServerReachability).toHaveBeenCalledWith(
            expect.objectContaining({
                serverUrl: 'https://scoped.example',
                token: 'tok-scoped',
                url: 'https://scoped.example/v2/sessions/sid-2/read-state',
                timeoutMs: 1000,
                init: expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer tok-scoped',
                        'Content-Type': 'application/json',
                    }),
                    body: JSON.stringify({ state: 'read' }),
                }),
            }),
        );
        expect(mockRequest).not.toHaveBeenCalled();
    });

    it('keeps a nullable cursor and lowers stale legacy metadata after success', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession({
                lastViewedSessionSeq: null,
                metadata: {
                    path: '',
                    host: '',
                    readStateV1: { v: 1, sessionSeq: 7, pendingActivityAt: 0, updatedAt: 100 },
                },
            }),
        };
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: null, didChange: false },
        }));

        const res = await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-a' });

        expect(res).toEqual({ success: true, readState: 'unread', lastViewedSessionSeq: null, didChange: false });
        expect(mockStorageState.applySessions).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'sid-1',
                lastViewedSessionSeq: null,
                metadata: expect.objectContaining({
                    readStateV1: expect.objectContaining({ sessionSeq: 6 }),
                }),
            }),
        ]);
    });

    it('updates direct-session attention metadata when marking unread', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession({
                seq: 0,
                lastViewedSessionSeq: 0,
                metadata: {
                    path: '',
                    host: '',
                    externalSessionV1: {
                        v: 1,
                        agentId: 'codex',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'codexHome', home: 'user' },
                    },
                    externalSessionAttentionV1: {
                        v: 1,
                        observedProgressToken: '2:message',
                        viewedProgressToken: '2:message',
                    },
                },
            }),
        };
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: 0, didChange: false },
        }));

        await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-a' });

        const appliedSession = mockStorageState.applySessions.mock.calls[0]?.[0]?.[0];
        expect(appliedSession?.metadata?.externalSessionAttentionV1).toEqual({
            v: 1,
            observedProgressToken: '2:message',
        });
    });

    it('patches renderable unread state when only a list renderable is cached', async () => {
        mockStorageState.sessionListRenderables = {
            'sid-1': makeSession({ hasUnreadMessages: false }),
        };
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: 6, didChange: true },
        }));

        await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-a' });

        expect(mockStorageState.applySessions).not.toHaveBeenCalled();
        expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
            { sessionId: 'sid-1', patch: { hasUnreadMessages: true, lastViewedSessionSeq: 6 } },
        ]);
    });

    it('patches renderable cursors even when the unread flag is unchanged', async () => {
        mockStorageState.sessionListRenderables = {
            'sid-1': makeSession({ hasUnreadMessages: false, lastViewedSessionSeq: 6 }),
        };
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'read', lastViewedSessionSeq: 7, didChange: true },
        }));

        await sessionSetManualReadStateWithServerScope('sid-1', 'read', { serverId: 'server-a' });

        expect(mockStorageState.applySessions).not.toHaveBeenCalled();
        expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
            { sessionId: 'sid-1', patch: { hasUnreadMessages: false, lastViewedSessionSeq: 7 } },
        ]);
    });

    it('lowers stale legacy metadata when patching a renderable-only unread null cursor', async () => {
        mockStorageState.sessionListRenderables = {
            'sid-1': makeSession({
                hasUnreadMessages: false,
                lastViewedSessionSeq: null,
                metadata: {
                    path: '',
                    host: '',
                    readStateV1: { v: 1, sessionSeq: 7, pendingActivityAt: 0, updatedAt: 100 },
                },
            }),
        };
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: null, didChange: false },
        }));

        await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-a' });

        expect(mockStorageState.applySessions).not.toHaveBeenCalled();
        expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([
            {
                sessionId: 'sid-1',
                patch: expect.objectContaining({
                    hasUnreadMessages: true,
                    lastViewedSessionSeq: null,
                    metadata: expect.objectContaining({
                        readStateV1: expect.objectContaining({ sessionSeq: 6 }),
                    }),
                }),
            },
        ]);
    });

    it('patches the non-active server cache without mutating active-server session state', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession({ lastViewedSessionSeq: 7 }),
        };
        const serverBRows: Record<string, SessionListRenderableSession> = {
            'sid-1': {
                id: 'sid-1',
                seq: 7,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 0,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: null,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
            },
        };
        mockStorageState.concurrentSessionListCacheByServerId = {
            'server-b': {
                serverName: 'Server B',
                sessions: serverBRows,
            },
        };
        mockStorageState.sessionListRowStateByServerId = {
            'server-b': serverBRows,
        };
        mockStorageState.sessionListIndexByServerId = {
            'server-b': [{ type: 'session', sessionId: 'sid-1' }] satisfies SessionListIndexItem[],
        };
        const previousIndex = mockStorageState.sessionListIndexByServerId['server-b'];
        mockResolveContext.mockResolvedValue({
            scope: 'scoped',
            targetServerUrl: 'https://scoped.example',
            targetServerId: 'server-b',
            token: 'tok-scoped',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRuntimeFetchWithServerReachability.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: 6, didChange: true },
        }));

        await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-b' });

        expect(mockStorageState.applySessions).not.toHaveBeenCalled();
        expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
        expect(mockStorageState.concurrentSessionListCacheByServerId['server-b']?.sessions?.['sid-1']?.hasUnreadMessages).toBe(true);
        expect(mockStorageState.concurrentSessionListCacheByServerId['server-b']?.sessions?.['sid-1']?.lastViewedSessionSeq).toBe(6);
        expect(mockStorageState.sessionListRowStateByServerId['server-b']?.['sid-1']?.hasUnreadMessages).toBe(true);
        expect(mockStorageState.sessionListRowStateByServerId['server-b']?.['sid-1']?.lastViewedSessionSeq).toBe(6);
        expect(mockStorageState.sessionListIndexByServerId['server-b']).not.toBe(previousIndex);
    });

    it('lowers stale legacy metadata when patching a non-active cache unread null cursor', async () => {
        const serverBRows: Record<string, SessionListRenderableSession> = {
            'sid-1': {
                id: 'sid-1',
                seq: 7,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                pendingCount: 0,
                pendingVersion: 0,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    path: '',
                    host: '',
                    readStateV1: { v: 1, sessionSeq: 7, pendingActivityAt: 0, updatedAt: 100 },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                hasUnreadMessages: false,
                lastViewedSessionSeq: null,
            },
        };
        mockStorageState.concurrentSessionListCacheByServerId = {
            'server-b': {
                serverName: 'Server B',
                sessions: serverBRows,
            },
        };
        mockStorageState.sessionListRowStateByServerId = {
            'server-b': serverBRows,
        };
        mockResolveContext.mockResolvedValue({
            scope: 'scoped',
            targetServerUrl: 'https://scoped.example',
            targetServerId: 'server-b',
            token: 'tok-scoped',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRuntimeFetchWithServerReachability.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: null, didChange: false },
        }));

        await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-b' });

        expect(mockStorageState.concurrentSessionListCacheByServerId['server-b']?.sessions?.['sid-1']?.metadata?.readStateV1?.sessionSeq).toBe(6);
        expect(mockStorageState.sessionListRowStateByServerId['server-b']?.['sid-1']?.metadata?.readStateV1?.sessionSeq).toBe(6);
    });

    it('registers an active-view hold after marking the focused session unread', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession({ lastViewedSessionSeq: 7 }),
        };
        const activationId = beginSessionViewingActivation('sid-1');
        setFocusedSessionId('sid-1');
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: true,
            json: { success: true, state: 'unread', lastViewedSessionSeq: 6, didChange: true },
        }));

        await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-a' });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 'sid-1', sessionSeq: 7, activationId })).toBe(true);
    });

    it('returns a structured failure without applying local state', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession(),
        };
        mockResolveContext.mockResolvedValue({
            scope: 'active',
            targetServerUrl: 'https://active.example',
            targetServerId: 'server-a',
            token: 'tok',
            timeoutMs: 1000,
            encryption: null,
        });
        mockRequest.mockResolvedValue(makeResponse({
            ok: false,
            status: 403,
            text: 'Forbidden',
        }));

        const res = await sessionSetManualReadStateWithServerScope('sid-1', 'unread', { serverId: 'server-a' });

        expect(res).toEqual({ success: false, message: 'Forbidden' });
        expect(mockStorageState.applySessions).not.toHaveBeenCalled();
        expect(mockStorageState.applySessionListRenderablePatches).not.toHaveBeenCalled();
    });
});
