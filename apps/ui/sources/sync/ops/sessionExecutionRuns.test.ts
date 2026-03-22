import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());
const canUseSessionRpcMock = vi.hoisted(() => vi.fn(() => true));
const notifyExecutionRunActivityMock = vi.hoisted(() => vi.fn());
const expectRpcTimeout = expect.objectContaining({ timeoutMs: expect.any(Number) });

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: sessionRpcMock,
    },
}));

vi.mock('./sessionMachineTarget', () => ({
    canUseSessionRpc: (...args: Parameters<typeof canUseSessionRpcMock>) => canUseSessionRpcMock(...args),
}));

vi.mock('@/sync/runtime/executionRuns/executionRunActivityBus', () => ({
    notifyExecutionRunActivity: (...args: Parameters<typeof notifyExecutionRunActivityMock>) =>
        notifyExecutionRunActivityMock(...args),
}));

describe('sessionExecutionRuns', () => {
    let sessionExecutionRuns: typeof import('./sessionExecutionRuns');

    beforeAll(async () => {
        vi.resetModules();
        sessionExecutionRuns = await import('./sessionExecutionRuns');
    }, 120_000);

    afterAll(() => {
        vi.resetModules();
    });

    afterEach(() => {
        sessionRpcMock.mockReset();
        canUseSessionRpcMock.mockReset();
        canUseSessionRpcMock.mockReturnValue(true);
        notifyExecutionRunActivityMock.mockReset();
    });

    it('calls execution.run.action through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunAction('session-1', {
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
            expectRpcTimeout,
        );
        expect(response.ok).toBe(true);
    });

    it('notifies execution-run activity after execution.run.action succeeds', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunAction('session-1', {
            runId: 'run_1',
            actionId: 'review.triage',
            input: { findings: [{ id: 'f1', status: 'accept' }] },
        });

        expect(response).toEqual({ ok: true });
        expect(notifyExecutionRunActivityMock).toHaveBeenCalledWith('session-1');
    });

    it('calls execution.run.start through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' });

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                instructions: 'Review this repo.',
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            },
            expectRpcTimeout,
        );
        expect((response as any).runId).toBe('run_1');
    });

    it('returns ok:false error shapes from execution.run.start without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Permission denied', errorCode: 'permission_denied' });

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            instructions: 'Review this repo.',
            permissionMode: 'full',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('permission_denied');
    });

    it('returns bare error responses from execution.run.start without collapsing them to unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ error: 'Unable to resolve a default base branch for CodeRabbit review.' });

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-1', {
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
            instructions: 'Review this repo.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect((response as any).ok).toBe(false);
        expect((response as any).error).toBe('Unable to resolve a default base branch for CodeRabbit review.');
    });

    it('fails closed for execution.run.start when the session is inactive', async () => {
        canUseSessionRpcMock.mockReturnValue(false);

        const response = await sessionExecutionRuns.sessionExecutionRunStart('session-inactive', {
            intent: 'review',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            instructions: 'Review this repo.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        });

        expect(sessionRpcMock).not.toHaveBeenCalled();
        expect(response).toEqual({
            ok: false,
            error: 'Session RPC unavailable for inactive session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it('calls execution.run.send through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunSend('session-1', { runId: 'run_1', message: 'hello' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
            { runId: 'run_1', message: 'hello', delivery: 'steer_if_supported' },
            expectRpcTimeout,
        );
        expect(response.ok).toBe(true);
    });

    it('notifies execution-run activity after execution.run.send succeeds', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunSend('session-1', { runId: 'run_1', message: 'hello' });

        expect(response).toEqual({ ok: true });
        expect(notifyExecutionRunActivityMock).toHaveBeenCalledWith('session-1');
    });

    it('returns ok:false error shapes from execution.run.send without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Not found', errorCode: 'execution_run_not_found' });

        const response = await sessionExecutionRuns.sessionExecutionRunSend('session-1', { runId: 'run_1', message: 'hello' });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('execution_run_not_found');
    });

    it('allows execution.run.send for inactive sessions through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });
        canUseSessionRpcMock.mockReturnValue(false);

        const response = await sessionExecutionRuns.sessionExecutionRunSend('session-inactive', { runId: 'run_1', message: 'hello' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-inactive',
            SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
            { runId: 'run_1', message: 'hello', delivery: 'steer_if_supported' },
            expectRpcTimeout,
        );
        expect(response).toEqual({ ok: true });
    });

    it('calls execution.run.stop through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-1', { runId: 'run_1' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            { runId: 'run_1' },
            expectRpcTimeout,
        );
        expect(response.ok).toBe(true);
    });

    it('notifies execution-run activity after execution.run.stop succeeds', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-1', { runId: 'run_1' });

        expect(response).toEqual({ ok: true });
        expect(notifyExecutionRunActivityMock).toHaveBeenCalledWith('session-1');
    });

    it('returns ok:false error shapes from execution.run.stop without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Not running', errorCode: 'execution_run_not_allowed' });

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-1', { runId: 'run_1' });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('execution_run_not_allowed');
    });

    it('allows execution.run.stop for inactive sessions through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });
        canUseSessionRpcMock.mockReturnValue(false);

        const response = await sessionExecutionRuns.sessionExecutionRunStop('session-inactive', { runId: 'run_1' });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-inactive',
            SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            { runId: 'run_1' },
            expectRpcTimeout,
        );
        expect(response).toEqual({ ok: true });
    });

    it('calls execution.run.list through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ runs: [] });

        const response = await sessionExecutionRuns.sessionExecutionRunList('session-1', {});

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
            {},
            expectRpcTimeout,
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
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                status: 'succeeded',
                startedAtMs: 1,
                finishedAtMs: 2,
            },
        });

        const response = await sessionExecutionRuns.sessionExecutionRunGet('session-1', { runId: 'run_1', includeStructured: true });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            { runId: 'run_1', includeStructured: true },
            expectRpcTimeout,
        );
        expect((response as any).run?.runId).toBe('run_1');
    });

    it('returns ok:false error shapes from execution.run.get without treating them as unsupported', async () => {
        sessionRpcMock.mockResolvedValue({ ok: false, error: 'Not found', errorCode: 'execution_run_not_found' });

        const response = await sessionExecutionRuns.sessionExecutionRunGet('session-1', { runId: 'run_1', includeStructured: true });

        expect((response as any).ok).toBe(false);
        expect((response as any).errorCode).toBe('execution_run_not_found');
    });

    it('allows execution.run.action for inactive sessions through session RPC', async () => {
        sessionRpcMock.mockResolvedValue({ ok: true });
        canUseSessionRpcMock.mockReturnValue(false);

        const response = await sessionExecutionRuns.sessionExecutionRunAction('session-inactive', {
            runId: 'run_1',
            actionId: 'review.triage',
            input: { findings: [{ id: 'f1', status: 'accept' }] },
        });

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-inactive',
            SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            {
                runId: 'run_1',
                actionId: 'review.triage',
                input: { findings: [{ id: 'f1', status: 'accept' }] },
            },
            expectRpcTimeout,
        );
        expect(response).toEqual({ ok: true });
    });

    it('detects terminal not-running send errors by error code', async () => {
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningSendError({
                ok: false,
                error: 'Not running',
                errorCode: 'execution_run_not_allowed',
            }),
        ).toBe(true);
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningSendError({
                ok: false,
                error: 'Already finished',
                errorCode: 'execution_run_not_running',
            }),
        ).toBe(true);
    });

    it('detects terminal not-running send errors by message fallback', async () => {
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningSendError({
                ok: false,
                error: 'execution run is not running anymore',
            }),
        ).toBe(true);
        expect(
            sessionExecutionRuns.isExecutionRunNotRunningSendError({
                ok: false,
                error: 'some other transport failure',
            }),
        ).toBe(false);
    });
});
