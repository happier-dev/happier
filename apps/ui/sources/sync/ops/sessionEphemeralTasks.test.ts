import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcWithServerScopeMock(params),
}));

vi.mock('../runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

describe('sessionEphemeralTasks', () => {
    afterEach(() => {
        sessionRpcWithServerScopeMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
    });

    it('calls ephemeral.task.run through the preferred session owner scope when no explicit serverId is provided', async () => {
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
        sessionRpcWithServerScopeMock.mockResolvedValue({ ok: true, result: { title: 't', body: '', message: 't' } });

        const { sessionEphemeralTaskRun } = await import('./sessionEphemeralTasks');
        const response = await sessionEphemeralTaskRun('session-1', {
            kind: 'scm.commit_message',
            sessionId: 'session-1',
            input: { backendId: 'claude' },
            permissionMode: 'no_tools',
        });

        expect(resolvePreferredServerIdForSessionIdMock).toHaveBeenCalledWith('session-1');
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            serverId: 'server-owned',
            method: SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN,
            payload: {
                kind: 'scm.commit_message',
                sessionId: 'session-1',
                input: { backendId: 'claude' },
                permissionMode: 'no_tools',
            },
        });
        expect((response as any).ok).toBe(true);
    });
});
