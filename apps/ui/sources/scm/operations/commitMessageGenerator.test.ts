import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

const { actionExecuteMock, createFrontDoorActionExecuteMock } = vi.hoisted(() => {
    const actionExecuteMock = vi.fn();
    return {
        actionExecuteMock,
        createFrontDoorActionExecuteMock: vi.fn(() => actionExecuteMock),
    };
});

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
            executionRunCheckProtocolV2: async (_sessionId, _requirements, opts) => ({ ok: true, exactMachineId: opts?.targetMachineId ?? undefined }),
            executionRunStart,
            executionRunGet,
            executionRunWait,
        }));
        actionExecuteMock.mockImplementation(executor.execute);
        const { generateScmCommitMessage } = await import('./commitMessageGenerator');

        expect(await generateScmCommitMessage({
            host: { kind: 'workspace', workspace: { serverId: 'home_a', workspaceId: 'workspace_a', machineId: 'machine_a', rootPath: '/repo' } },
            backendId: 'claude', scopePaths: ['file ', ' ', ''],
        })).toMatchObject({ ok: true, message: 'feat: update stuff' });
        expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({
            // sessionPermissionModes owns the retained wire alias; the native profile enforces no_tools.
            cwd: '/repo', kind: 'scm_commit_message.v1', intent: 'scm_commit_message', permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            intentInput: { scope: { kind: 'paths', include: ['file ', ' '] } },
        }), expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a', exactMachineId: 'machine_a' }));
        expect(executionRunGet).not.toHaveBeenCalled();
        expect(executionRunWait).toHaveBeenCalledWith(null, expect.objectContaining({ runId: 'run_1' }),
            expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a' }));
        actionExecuteMock.mockReset();
    });

    it('observes and cancels an accepted detached Run on its original Home and Machine without redispatch', async () => {
        const executionRunGet = vi.fn(async () => successfulTerminalResult().result);
        const executionRunStop = vi.fn(async () => ({ ok: true as const }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            executionRunCheckProtocolV2: async (_sessionId, _requirements, opts) => ({ ok: true, exactMachineId: opts?.targetMachineId ?? undefined }),
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
        actionExecuteMock
            .mockResolvedValueOnce(startResult({
                ok: true,
                status: 'succeeded',
                result: successfulTerminalResult().result,
            }));

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
        expect(actionExecuteMock.mock.calls.map(([id]) => id)).toEqual(['execution.run.start']);
        expect(startInput).not.toHaveProperty('waitTimeoutSeconds');
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
        }, 'Commit message generation is still running', 'pending'],
        ['cancelled', { ok: false, code: 'cancelled' }, 'Commit message observation was cancelled', 'unknown'],
    ] as const)('returns the canonical %s observation result without redispatching or stopping', async (errorCode, wait, error, outcome) => {
        actionExecuteMock.mockResolvedValueOnce(startResult(wait));

        await expect(generate()).resolves.toMatchObject({ ok: false, error, errorCode, runId: 'run_1', outcome });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
        expect(actionExecuteMock).toHaveBeenCalledWith(
            'execution.run.start',
            expect.objectContaining({ waitForCompletion: true }),
            expect.any(Object),
        );
        expect(actionExecuteMock.mock.calls.map(([actionId]) => actionId)).not.toContain('execution.run.stop');
    });

    it.each([
        ['execution_run_protocol_unsupported', 'protocol unavailable'],
        ['execution_run_target_unavailable', 'target unavailable'],
    ] as const)('preserves the %s Action failure without another dispatch', async (errorCode, error) => {
        actionExecuteMock.mockResolvedValueOnce({ ok: false, errorCode, error });

        await expect(generate()).resolves.toEqual({ ok: false, error, errorCode });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
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
    });

    it('fails closed when the waited terminal run is not the run it started', async () => {
        actionExecuteMock.mockResolvedValueOnce(startResult({
            ok: true,
            status: 'succeeded',
            result: successfulTerminalResult('run_other').result,
        }));

        await expect(generate()).resolves.toMatchObject({ ok: false, runId: 'run_1', outcome: 'unknown' });

        expect(actionExecuteMock).toHaveBeenCalledTimes(1);
    });

});
