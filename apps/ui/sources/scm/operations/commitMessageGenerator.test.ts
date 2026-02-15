import { describe, expect, it, vi } from 'vitest';

const sessionEphemeralTaskRunMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessionEphemeralTasks', () => ({
    sessionEphemeralTaskRun: sessionEphemeralTaskRunMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (_sessionId: string) => 'server_1',
}));

describe('commitMessageGenerator', () => {
    it('calls scm.commit_message via sessionEphemeralTaskRun with scope paths and no patches', async () => {
        sessionEphemeralTaskRunMock.mockResolvedValue({
            ok: true,
            result: { message: 'feat: update stuff' },
        });

        const { generateScmCommitMessage } = await import('./commitMessageGenerator');
        const res = await generateScmCommitMessage({
            sessionId: 'sess_1',
            backendId: 'claude',
            instructions: 'use conventional commits',
            scopePaths: ['a.txt', 'b.txt'],
        });

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.message).toBe('feat: update stuff');
        }

        expect(sessionEphemeralTaskRunMock).toHaveBeenCalledWith(
            'sess_1',
            {
                kind: 'scm.commit_message',
                sessionId: 'sess_1',
                input: {
                    backendId: 'claude',
                    instructions: 'use conventional commits',
                    scope: { kind: 'paths', include: ['a.txt', 'b.txt'] },
                },
                permissionMode: 'no_tools',
            },
            { serverId: 'server_1' },
        );

        const call = sessionEphemeralTaskRunMock.mock.calls[0]?.[1];
        expect(call?.input?.patches).toBeUndefined();
    });
});

