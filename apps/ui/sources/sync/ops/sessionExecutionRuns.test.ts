import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: sessionRpcMock,
    },
}));

describe('sessionExecutionRuns', () => {
    afterEach(() => {
        sessionRpcMock.mockReset();
    });

    it('calls execution.run.action through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const { sessionExecutionRunAction } = await import('./sessionExecutionRuns');
        const response = await sessionExecutionRunAction('session-1', {
            runId: 'run_1',
            actionId: 'review.triage',
            input: { findings: [{ id: 'f1', status: 'accept' }] },
        });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            {
                runId: 'run_1',
                actionId: 'review.triage',
                input: { findings: [{ id: 'f1', status: 'accept' }] },
            },
        );
        expect(response.ok).toBe(true);
    });

    it('calls execution.run.start through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' });

        const { sessionExecutionRunStart } = await import('./sessionExecutionRuns');
        const response = await sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendId: 'claude',
            instructions: 'Review this repo.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_START,
            {
                intent: 'review',
                backendId: 'claude',
                instructions: 'Review this repo.',
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            },
        );
        expect((response as any).runId).toBe('run_1');
    });

    it('returns ok:false error shapes from execution.run.start without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Permission denied', errorCode: 'permission_denied' });

        const { sessionExecutionRunStart } = await import('./sessionExecutionRuns');
        const response = await sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendId: 'claude',
            instructions: 'Review this repo.',
            permissionMode: 'full',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('permission_denied');
    });

    it('calls execution.run.send through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const { sessionExecutionRunSend } = await import('./sessionExecutionRuns');
        const response = await sessionExecutionRunSend('session-1', { runId: 'run_1', message: 'hello' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
            { runId: 'run_1', message: 'hello' },
        );
        expect(response.ok).toBe(true);
    });

    it('calls execution.run.stop through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const { sessionExecutionRunStop } = await import('./sessionExecutionRuns');
        const response = await sessionExecutionRunStop('session-1', { runId: 'run_1' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            { runId: 'run_1' },
        );
        expect(response.ok).toBe(true);
    });

    it('calls execution.run.list through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ runs: [] });

        const { sessionExecutionRunList } = await import('./sessionExecutionRuns');
        const response = await sessionExecutionRunList('session-1', {});

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
            {},
        );
        expect(Array.isArray((response as any).runs)).toBe(true);
    });

    it('calls execution.run.get through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'call_1',
                intent: 'review',
                backendId: 'claude',
                status: 'succeeded',
                startedAtMs: 1,
                finishedAtMs: 2,
            },
        });

        const { sessionExecutionRunGet } = await import('./sessionExecutionRuns');
        const response = await sessionExecutionRunGet('session-1', { runId: 'run_1', includeStructured: true });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            { runId: 'run_1', includeStructured: true },
        );
        expect((response as any).run?.runId).toBe('run_1');
    });
});
