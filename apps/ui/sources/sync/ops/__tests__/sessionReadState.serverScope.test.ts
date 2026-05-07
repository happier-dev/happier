import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockResolveContext, mockRuntimeFetchWithServerReachability, mockStorageState } = vi.hoisted(() => ({
    mockRequest: vi.fn(),
    mockResolveContext: vi.fn(),
    mockRuntimeFetchWithServerReachability: vi.fn(),
    mockStorageState: {
        sessions: {},
        sessionListRenderables: {},
        applySessions: vi.fn(),
        applySessionListRenderablePatches: vi.fn(),
    } as {
        sessions: Record<string, any>;
        sessionListRenderables: Record<string, any>;
        applySessions: ReturnType<typeof vi.fn>;
        applySessionListRenderablePatches: ReturnType<typeof vi.fn>;
    },
}));

vi.mock('../../api/session/apiSocket', () => ({
    apiSocket: {
        request: mockRequest,
    },
}));

vi.mock('../../runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext', () => ({
    resolveServerScopedSessionContext: mockResolveContext,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: mockRuntimeFetchWithServerReachability,
}));

vi.mock('../../domains/state/storage', () => ({
    storage: {
        getState: () => mockStorageState,
    },
}));

import { sessionSetManualReadStateWithServerScope } from '../../ops';
import { clearActiveViewingSessionId, setActiveViewingSessionId } from '../../domains/session/activeViewingSession';
import {
    beginSessionViewingActivation,
    resetSessionManualUnreadHoldsForTests,
    holdManualUnreadForActivation,
    shouldSuppressAutomaticMarkViewed,
} from '../../domains/session/readState/sessionManualUnreadHold';

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
    return {
        ok: opts.ok,
        status: opts.status ?? (opts.ok ? 200 : 500),
        json: async () => opts.json ?? {},
        text: async () => opts.text ?? '',
        headers: new Map(),
    } as any;
}

function makeSession(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sid-1',
        seq: 7,
        lastViewedSessionSeq: 7,
        metadata: null,
        updatedAt: 100,
        ...overrides,
    };
}

describe('sessionSetManualReadStateWithServerScope', () => {
    beforeEach(() => {
        mockRequest.mockReset();
        mockResolveContext.mockReset();
        mockRuntimeFetchWithServerReachability.mockReset();
        mockStorageState.sessions = {};
        mockStorageState.sessionListRenderables = {};
        mockStorageState.applySessions.mockReset();
        mockStorageState.applySessionListRenderablePatches.mockReset();
        resetSessionManualUnreadHoldsForTests();
        clearActiveViewingSessionId('sid-1');
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

    it('applies returned read cursors to session-list renderables without waiting for hydration', async () => {
        mockStorageState.sessionListRenderables = {
            'sid-1': {
                id: 'sid-1',
                seq: 7,
                lastViewedSessionSeq: 6,
                hasUnreadMessages: true,
            },
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

        const res = await sessionSetManualReadStateWithServerScope('sid-1', 'read', { serverId: 'server-a' });

        expect(res).toEqual({ success: true, readState: 'read', lastViewedSessionSeq: 7, didChange: true });
        expect(mockStorageState.applySessions).not.toHaveBeenCalled();
        expect(mockStorageState.applySessionListRenderablePatches).toHaveBeenCalledWith([{
            sessionId: 'sid-1',
            patch: {
                lastViewedSessionSeq: 7,
                hasUnreadMessages: false,
            },
        }]);
    });

    it('registers an active-view hold after marking the current session unread', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession({ lastViewedSessionSeq: 7 }),
        };
        const activationId = beginSessionViewingActivation('sid-1');
        setActiveViewingSessionId('sid-1', activationId);
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

    it('preserves another activation unread hold after marking the current activation read', async () => {
        mockStorageState.sessions = {
            'sid-1': makeSession({ lastViewedSessionSeq: 6 }),
        };
        const currentActivationId = beginSessionViewingActivation('sid-1');
        const otherActivationId = beginSessionViewingActivation('sid-1');
        setActiveViewingSessionId('sid-1', currentActivationId);
        holdManualUnreadForActivation({ sessionId: 'sid-1', sessionSeq: 7, activationId: currentActivationId });
        holdManualUnreadForActivation({ sessionId: 'sid-1', sessionSeq: 7, activationId: otherActivationId });
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

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 'sid-1', sessionSeq: 7, activationId: currentActivationId })).toBe(false);
        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 'sid-1', sessionSeq: 7, activationId: otherActivationId })).toBe(true);
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
    });
});
