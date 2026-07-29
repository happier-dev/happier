import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

const { mockSessionRpcWithPreferredSessionScope } = vi.hoisted(() => ({
    mockSessionRpcWithPreferredSessionScope: vi.fn(),
}));

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

import { sessionAllow, sessionAllowWithAnswers, sessionAllowWithPermissionUpdates, sessionDeny } from './sessions';

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
});

describe('session permission/user-action RPC methods', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        mockSessionRpcWithPreferredSessionScope.mockReset();
        mockSessionRpcWithPreferredSessionScope.mockResolvedValue(undefined);
    });

    it('routes direct permission approvals through the canonical permission RPC method', async () => {
        const sessionId = 's_permission_allow';

        await sessionAllow(sessionId, 'perm_approve', 'acceptEdits', ['Edit'], 'approved_for_session', { command: ['npm', 'test'] });

        expect(mockSessionRpcWithPreferredSessionScope).toHaveBeenCalledWith({
            sessionId,
            method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: {
                id: 'perm_approve',
                approved: true,
                mode: 'acceptEdits',
                allowedTools: ['Edit'],
                decision: 'approved_for_session',
                execPolicyAmendment: { command: ['npm', 'test'] },
            },
        });
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
                approved: true,
                answers: {
                    'Pick one': ['A'],
                    'Pick several': ['Alpha, Beta', 'Gamma'],
                },
            },
        });
    });
});
