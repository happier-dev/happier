import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: sessionRpcMock,
    },
}));

describe('sessionEphemeralTasks', () => {
    afterEach(() => {
        sessionRpcMock.mockReset();
    });

    it('calls ephemeral.task.run through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true, result: { title: 't', body: '', message: 't' } });

        const { sessionEphemeralTaskRun } = await import('./sessionEphemeralTasks');
        const response = await sessionEphemeralTaskRun('session-1', {
            kind: 'scm.commit_message',
            sessionId: 'session-1',
            input: { backendId: 'claude' },
            permissionMode: 'no_tools',
        });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN,
            {
                kind: 'scm.commit_message',
                sessionId: 'session-1',
                input: { backendId: 'claude' },
                permissionMode: 'no_tools',
            },
        );
        expect((response as any).ok).toBe(true);
    });
});

