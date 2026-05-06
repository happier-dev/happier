import { describe, expect, it, vi } from 'vitest';

const sessionExecutionRunStartMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunGetMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: sessionExecutionRunStartMock,
    sessionExecutionRunGet: sessionExecutionRunGetMock,
}));

describe('commitMessageGenerator', () => {
    it('starts scm_commit_message.v1 through execution runs with scope paths and no patches', async () => {
        sessionExecutionRunStartMock.mockResolvedValue({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' });
        sessionExecutionRunGetMock.mockResolvedValue({
            run: { runId: 'run_1', status: 'succeeded' },
            latestToolResult: { message: 'feat: update stuff' },
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

        expect(sessionExecutionRunStartMock).toHaveBeenCalledWith(
            'sess_1',
            {
                kind: 'scm_commit_message.v1',
                intent: 'scm_commit_message',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                permissionMode: 'no_tools',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
                intentInput: {
                    instructions: 'use conventional commits',
                    scope: { kind: 'paths', include: ['a.txt', 'b.txt'] },
                },
            },
        );

        const call = sessionExecutionRunStartMock.mock.calls[0]?.[1];
        expect(call?.intentInput?.patches).toBeUndefined();
    });
});
