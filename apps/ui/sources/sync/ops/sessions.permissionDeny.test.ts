import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

const { mockSessionRpcWithPreferredSessionScope } = vi.hoisted(() => ({
    mockSessionRpcWithPreferredSessionScope: vi.fn(),
}));

// Native SDK boundary: the global Node stub is not evidence of a web client.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (...args: unknown[]) => mockSessionRpcWithPreferredSessionScope(...args),
}));

// sessions.ts imports sync, which pulls native modules in node/vitest.
vi.mock('../sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

import { sessionAllow, sessionAllowWithAnswers, sessionAllowWithPermissionUpdates, sessionDeny, sessionRespondToPermission } from './sessions';

const initialStorageState = storage.getState();

function buildSession(sessionId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: true,
        thinkingAt: 1,
        presence: 'online',
    };
}

describe('sessionDeny', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        mockSessionRpcWithPreferredSessionScope.mockReset();
    });

    it('clears local thinking state after a deny/abort permission decision', async () => {
        const sessionId = 's_permission_deny';
        storage.getState().applySessions([buildSession(sessionId)]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);

        await sessionDeny(sessionId, 'perm_1', undefined, undefined, 'abort');

        const session = storage.getState().sessions[sessionId];
        expect(session?.thinking).toBe(false);
        expect(session?.optimisticThinkingAt ?? null).toBeNull();
        expect(typeof session?.thinkingGraceUntil).toBe('number');
        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenCalledWith({
            sessionId,
            method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: expect.objectContaining({ id: 'perm_1', approved: false, decision: 'abort' }),
        });
    });

    it('uses Home B request context without clearing the same-ID Home A session', async () => {
        const sessionId = 'same-session';
        const activeSession = { ...buildSession(sessionId), serverId: 'home-a' };
        storage.getState().applySessions([activeSession]);
        const before = storage.getState().sessions[sessionId];

        await sessionDeny(sessionId, 'request', undefined, undefined, 'denied', undefined, 'turn-b', { serverId: 'home-b' });

        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'home-b', sessionId,
            payload: expect.objectContaining({ turnId: 'turn-b', approved: false }),
        }));
        expect(storage.getState().sessions[sessionId]).toBe(before);
    });
});

describe('session permission/user-action RPC methods', () => {
    it('stamps the answering UI category at the authenticated response transport', async () => {
        await sessionRespondToPermission('session-platform', { id: 'request', approved: true });
        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ answeringClientCategory: 'web' }),
        }));
    });

    beforeEach(() => {
        storage.setState(initialStorageState, true);
        mockSessionRpcWithPreferredSessionScope.mockReset();
        mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);
    });

    it('stops after delivering the abort decision and propagates an abort failure', async () => {
        mockSessionRpcWithPreferredSessionScope.mockImplementation(async (request) => {
            if (request.method === 'abort') throw new Error('abort unavailable');
        });
        await expect(sessionRespondToPermission('s_stop', {
            id: 'perm_stop', approved: false, decision: 'abort', turnId: 'turn-stop',
        }, { serverId: 'home-b' })).rejects.toThrow('abort unavailable');
        expect(mockSessionRpcWithPreferredSessionScope.mock.calls.map(([request]) => request.method))
            .toEqual([RPC_METHODS.SESSION_PERMISSION_RESPOND, 'abort']);
        expect(mockSessionRpcWithPreferredSessionScope.mock.calls.every(([request]) => request.serverId === 'home-b'))
            .toBe(true);
    });

    it('routes direct permission approvals through the canonical permission RPC method', async () => {
        const sessionId = 's_permission_allow';

        await sessionAllow(sessionId, 'perm_approve', 'acceptEdits', ['Edit'], 'approved_for_session', { command: ['npm', 'test'] });

        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenCalledWith({
            sessionId,
            method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: {
                id: 'perm_approve',
                answeringClientCategory: 'web',
                approved: true,
                mode: 'acceptEdits',
                allowedTools: ['Edit'],
                decision: 'approved_for_session',
                execPolicyAmendment: { command: ['npm', 'test'] },
            },
        });
    });

    it('resolves a loaded owning Home request turn without borrowing another Home same-ID request', async () => {
        const session = {
            ...buildSession('same-session'), serverId: 'home-b',
            agentState: { requests: { request: { tool: 'Read', arguments: {}, turnId: 'turn-b' } } },
        };
        storage.getState().applySessions([session]);
        await sessionRespondToPermission(session.id, { id: 'request', approved: true }, { serverId: 'home-b' });
        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenLastCalledWith(expect.objectContaining({
            serverId: 'home-b', payload: expect.objectContaining({ turnId: 'turn-b' }),
        }));
        await sessionRespondToPermission(session.id, { id: 'request', approved: true }, { serverId: 'home-a' });
        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenLastCalledWith(expect.objectContaining({
            serverId: 'home-a', payload: expect.objectContaining({ turnId: undefined }),
        }));
    });

    it('routes direct permission-update approvals through the canonical permission RPC method', async () => {
        const sessionId = 's_permission_updates';
        const updatedPermissions = { permission_suggestions: [{ tool: 'Bash' }] };

        await sessionAllowWithPermissionUpdates(sessionId, 'perm_update', {
            mode: 'plan',
            allowedTools: ['Bash'],
            decision: 'approved_execpolicy_amendment',
            updatedPermissions,
        });

        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenCalledWith({
            sessionId,
            method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: {
                id: 'perm_update',
                answeringClientCategory: 'web',
                approved: true,
                mode: 'plan',
                allowedTools: ['Bash'],
                decision: 'approved_execpolicy_amendment',
                updatedPermissions,
            },
        });
    });

    it('routes direct AskUserQuestion answers through the canonical user-action RPC method', async () => {
        const sessionId = 's_user_action_answer';

        await sessionAllowWithAnswers(sessionId, 'question_1', {
            'Pick one': ['A'],
            'Pick several': ['Alpha, Beta', 'Gamma'],
        });

        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenCalledWith({
            sessionId,
            method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
            payload: {
                id: 'question_1',
                answeringClientCategory: 'web',
                approved: true,
                answers: {
                    'Pick one': ['A'],
                    'Pick several': ['Alpha, Beta', 'Gamma'],
                },
            },
        });
    });
});
