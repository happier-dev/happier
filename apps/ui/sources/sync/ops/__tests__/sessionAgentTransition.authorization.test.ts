import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RPC_METHODS, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';

const { mockMachineRpcWithServerScope } = vi.hoisted(() => ({
    mockMachineRpcWithServerScope: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: mockMachineRpcWithServerScope,
}));

import { runSessionAgentTransitionOnMachine } from '../sessionAgentTransition';

function buildRequest(sessionId: string) {
    return {
        v: 1 as const,
        sessionId,
        expectedCurrentAgentId: 'claude',
        selection: { v: 1 as const, agentId: 'codex' },
        input: { text: 'continue here', localId: 'agent-transition-local-1', meta: {} },
    };
}

/**
 * `session.agentTransition` is a canonical Session-write machine RPC. The
 * server rejects a classified Session-write call that carries no
 * authorization before it ever resolves a forwarding target, and the daemon
 * independently rejects one whose envelope names a different Session than the
 * decrypted payload. A caller that omits the envelope therefore cannot reach
 * the coordinator at all — which is exactly what a transport mock hides.
 */
describe('runSessionAgentTransitionOnMachine authorization', () => {
    beforeEach(() => {
        mockMachineRpcWithServerScope.mockReset();
        mockMachineRpcWithServerScope.mockResolvedValue({
            type: 'rejected',
            code: 'same_target',
            sourceEffect: 'none',
        });
    });

    it('supplies the canonical Session-write edit proof for the addressed Session', async () => {
        await runSessionAgentTransitionOnMachine({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: buildRequest('sess_1'),
        });

        expect(mockMachineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.SESSION_AGENT_TRANSITION,
            authorization: {
                kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                sessionId: 'sess_1',
            },
        }));
    });

    it('names the same Session the daemon reads back from the forwarded payload', async () => {
        await runSessionAgentTransitionOnMachine({
            machineId: 'machine-1',
            serverId: null,
            request: buildRequest('  sess_padded  '),
        });

        const call = mockMachineRpcWithServerScope.mock.calls[0]?.[0] as {
            payload: { sessionId: string };
            authorization?: { kind: string; sessionId: string };
        };
        expect(call.authorization).toEqual({
            kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
            sessionId: call.payload.sessionId,
        });
    });
});
