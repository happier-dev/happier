import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

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

function successfulTerminalResult(runId = 'run_1') {
    return {
        ok: true,
        result: {
            run: {
                runId,
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
        host: { kind: 'session', sessionId: 'sess_1' },
        backendId: 'claude',
        instructions: 'use conventional commits',
        scopePaths: ['a.txt', 'b.txt'],
    });
}

describe('commitMessageGenerator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actionExecuteMock.mockReset();
    });

    it('runs a workspace suggestion through real Action normalization with an explicit null Session and exact Machine/cwd', async () => {
        const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
        const executionRunGet = vi.fn(async () => successfulTerminalResult().result);
        const executionRunWait = vi.fn(async () => ({ ok: true as const, status: 'succeeded' as const, result: successfulTerminalResult().result }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            executionRunCheckProtocolV2: async (_sessionId, _requirements, opts) => ({ ok: true, exactMachineId: opts?.targetMachineId }),
            executionRunStart,
            executionRunGet,
            executionRunWait,
        }));
        actionExecuteMock.mockImplementation(executor.execute);
        const { generateScmCommitMessage } = await import('./commitMessageGenerator');

        expect(await generateScmCommitMessage({
            host: { kind: 'workspace', workspace: { serverId: 'home_a', workspaceId: 'workspace_a', machineId: 'machine_a', rootPath: '/repo' } },
            backendId: 'claude', scopePaths: ['a.txt'],
        })).toMatchObject({ ok: true, message: 'feat: update stuff' });
        expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({
            cwd: '/repo', kind: 'scm_commit_message.v1', intent: 'scm_commit_message', permissionMode: 'no_tools',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            intentInput: { scope: { kind: 'paths', include: ['a.txt'] } },
        }), expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a', exactMachineId: 'machine_a' }));
        expect(executionRunGet).toHaveBeenCalledWith(null, { runId: 'run_1', includeStructured: true },
            expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a' }));
        expect(executionRunWait).toHaveBeenCalledWith(null, expect.objectContaining({ runId: 'run_1' }),
            expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a' }));
        actionExecuteMock.mockReset();
    });

    it('retains accepted Run custody for an observation timeout without starting another Run', async () => {
        actionExecuteMock.mockResolvedValueOnce(startResult({ ok: true, status: 'running', disposition: 'observation_timeout', runId: 'run_1',
            timeoutMs: 12_000, observedAtMs: 13_000, deadlineAtMs: 13_000 }));
        const { generateScmCommitMessage } = await import('./commitMessageGenerator');
        expect(await generateScmCommitMessage({ host: { kind: 'session', sessionId: 'sess_1' }, backendId: 'claude' })).toMatchObject({
            ok: false, errorCode: 'timeout', runId: 'run_1', outcome: 'pending',
        });
        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
    });

    it('observes and cancels an accepted detached Run on its original Home and Machine without redispatch', async () => {
        const executionRunGet = vi.fn(async () => successfulTerminalResult().result);
        const executionRunStop = vi.fn(async () => ({ ok: true as const }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            executionRunCheckProtocolV2: async (_sessionId, _requirements, opts) => ({ ok: true, exactMachineId: opts?.targetMachineId }),
            executionRunGet, executionRunStop,
        }));
        actionExecuteMock.mockImplementation(executor.execute);
        const { readScmCommitMessageSuggestion, stopScmCommitMessageSuggestion } = await import('./commitMessageGenerator');
        const host = { kind: 'workspace' as const, workspace: { serverId: 'home_a', workspaceId: 'workspace_a', machineId: 'machine_a', rootPath: '/repo' } };
        expect(await readScmCommitMessageSuggestion({ host, runId: 'run_1' })).toMatchObject({ ok: true, message: 'feat: update stuff' });
        await stopScmCommitMessageSuggestion({ host, runId: 'run_1' });
        expect(executionRunGet).toHaveBeenCalledWith(null, { runId: 'run_1', includeStructured: true },
            expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a' }));
        expect(executionRunStop).toHaveBeenCalledWith(null, { runId: 'run_1' },
            expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a' }));
        expect(actionExecuteMock.mock.calls.map(([id]) => id)).toEqual(['execution.run.get', 'execution.run.stop']);
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
                result: successfulTerminalResult().result,
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
        ['timeout', {
            ok: true,
            status: 'running',
            disposition: 'observation_timeout',
            runId: 'run_1',
            timeoutMs: 12_000,
            observedAtMs: 13_000,
            deadlineAtMs: 13_000,
        }, 'Commit message generation is still running'],
        ['cancelled', { ok: false, code: 'cancelled' }, 'Commit message observation was cancelled'],
    ] as const)('returns the canonical %s observation result without redispatching or stopping', async (errorCode, wait, error) => {
        actionExecuteMock.mockResolvedValueOnce(startResult(wait));

        await expect(generate()).resolves.toMatchObject({ ok: false, error, errorCode, runId: 'run_1' });

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
    ] as const)('fails closed for a %s wait result without reading or redispatching the run', async (name, result) => {
        actionExecuteMock.mockResolvedValueOnce(result);

        await expect(generate()).resolves.toMatchObject(name === 'missing'
            ? { ok: false, runId: 'run_1', outcome: 'unknown' }
            : { ok: false, error: 'Commit message generation failed' });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
        expect(sessionExecutionRunStartMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunGetMock).not.toHaveBeenCalled();
    });

    it('fails closed when the waited terminal run is not the run it started', async () => {
        actionExecuteMock.mockResolvedValueOnce(startResult({
            ok: true,
            status: 'succeeded',
            result: successfulTerminalResult('run_other').result,
        }));

        await expect(generate()).resolves.toMatchObject({ ok: false, runId: 'run_1', outcome: 'unknown' });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
        expect(sessionExecutionRunStartMock).not.toHaveBeenCalled();
        expect(sessionExecutionRunGetMock).not.toHaveBeenCalled();
    });

    it('rejects contradictory terminal observation instead of applying a suggestion', async () => {
        actionExecuteMock.mockResolvedValueOnce(startResult({ ok: true, status: 'succeeded', result: successfulTerminalResult().result }))
            .mockResolvedValueOnce({ ok: true, result: {
                ...successfulTerminalResult().result,
                run: { ...successfulTerminalResult().result.run, status: 'failed' },
            } });
        expect(await generate()).toMatchObject({ ok: false, runId: 'run_1', outcome: 'unknown' });
    });
});
