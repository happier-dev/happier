import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionExecutionRunStartMock = vi.hoisted(() => vi.fn());
const sessionExecutionRunGetMock = vi.hoisted(() => vi.fn());
const { actionExecuteMock, createFrontDoorActionExecuteMock } = vi.hoisted(() => {
    const actionExecuteMock = vi.fn();
    return {
        actionExecuteMock,
        createFrontDoorActionExecuteMock: vi.fn(() => actionExecuteMock),
    };
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: sessionExecutionRunStartMock,
    sessionExecutionRunGet: sessionExecutionRunGetMock,
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: createFrontDoorActionExecuteMock,
}));

function startResult(wait: unknown) {
    return {
        ok: true,
        result: {
            runId: 'run_1',
            callId: 'call_1',
            sidechainId: 'call_1',
            wait,
        },
    };
}

function successfulTerminalResult() {
    return {
        ok: true,
        result: {
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'call_1',
                intent: 'scm_commit_message',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                permissionMode: 'no_tools',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
                status: 'succeeded',
                startedAtMs: 1,
                finishedAtMs: 2,
            },
            latestToolResult: { message: 'feat: update stuff' },
        },
    };
}

async function generate() {
    const { generateScmCommitMessage } = await import('./commitMessageGenerator');
    return await generateScmCommitMessage({
        sessionId: 'sess_1',
        backendId: 'claude',
        instructions: 'use conventional commits',
        scopePaths: ['a.txt', 'b.txt'],
    });
}

describe('commitMessageGenerator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('starts scm_commit_message.v1 through the Action front door and reads one canonical terminal result', async () => {
        sessionExecutionRunStartMock.mockResolvedValue({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' });
        sessionExecutionRunGetMock.mockResolvedValue({
            run: { runId: 'run_1', status: 'succeeded' },
            latestToolResult: { message: 'feat: update stuff' },
        });
        actionExecuteMock
            .mockResolvedValueOnce(startResult({
                ok: true,
                status: 'succeeded',
                result: { run: { runId: 'run_1', status: 'succeeded' } },
            }))
            .mockResolvedValueOnce(successfulTerminalResult());

        const res = await generate();

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.message).toBe('feat: update stuff');
        }

        expect(actionExecuteMock).toHaveBeenNthCalledWith(
            1,
            'execution.run.start',
            expect.objectContaining({
                sessionId: 'sess_1',
                kind: 'scm_commit_message.v1',
                intent: 'scm_commit_message',
                backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
                waitForCompletion: true,
                waitTimeoutSeconds: 12,
                permissionMode: 'no_tools',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
                intentInput: {
                    instructions: 'use conventional commits',
                    scope: { kind: 'paths', include: ['a.txt', 'b.txt'] },
                },
            }),
            {
                actionCaller: { kind: 'host' },
                defaultSessionId: 'sess_1',
                surface: 'ui',
            },
        );

        const startInput = actionExecuteMock.mock.calls[0]?.[1];
        expect(startInput?.intentInput?.patches).toBeUndefined();
        expect(actionExecuteMock).toHaveBeenNthCalledWith(
            2,
            'execution.run.get',
            { sessionId: 'sess_1', runId: 'run_1', includeStructured: true },
            {
                actionCaller: { kind: 'host' },
                defaultSessionId: 'sess_1',
                surface: 'ui',
            },
        );
        expect(sessionExecutionRunStartMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunGetMock).not.toHaveBeenCalled();
    });

    it.each([
        ['timeout', { ok: false, code: 'timeout' }, 'Commit message generation timed out'],
        ['cancelled', { ok: false, code: 'cancelled' }, 'Commit message generation was cancelled'],
    ] as const)('returns the canonical %s observation result without redispatching or stopping', async (errorCode, wait, error) => {
        actionExecuteMock.mockResolvedValueOnce(startResult(wait));

        await expect(generate()).resolves.toEqual({ ok: false, error, errorCode });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
        expect(actionExecuteMock).toHaveBeenCalledWith(
            'execution.run.start',
            expect.objectContaining({ waitForCompletion: true }),
            expect.any(Object),
        );
        expect(actionExecuteMock.mock.calls.map(([actionId]) => actionId)).not.toContain('execution.run.stop');
        expect(sessionExecutionRunStartMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunGetMock).not.toHaveBeenCalled();
    });

    it.each([
        ['execution_run_protocol_unsupported', 'protocol unavailable'],
        ['execution_run_target_unavailable', 'target unavailable'],
    ] as const)('preserves the %s Action failure without another dispatch', async (errorCode, error) => {
        actionExecuteMock.mockResolvedValueOnce({ ok: false, errorCode, error });

        await expect(generate()).resolves.toEqual({ ok: false, error, errorCode });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
        expect(sessionExecutionRunStartMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunGetMock).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', startResult(undefined)],
        ['malformed', startResult({ ok: false, code: 'not_a_wait_result' })],
    ] as const)('fails closed for a %s wait result without reading or redispatching the run', async (_name, result) => {
        actionExecuteMock.mockResolvedValueOnce(result);

        await expect(generate()).resolves.toEqual({ ok: false, error: 'Commit message generation failed' });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
        expect(sessionExecutionRunStartMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunGetMock).not.toHaveBeenCalled();
    });

    it('fails closed when the waited terminal run is not the run it started', async () => {
        actionExecuteMock.mockResolvedValueOnce(startResult({
            ok: true,
            status: 'succeeded',
            result: { run: { runId: 'run_other', status: 'succeeded' } },
        }));

        await expect(generate()).resolves.toEqual({ ok: false, error: 'Commit message generation failed' });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
        expect(sessionExecutionRunStartMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunGetMock).not.toHaveBeenCalled();
    });
});
