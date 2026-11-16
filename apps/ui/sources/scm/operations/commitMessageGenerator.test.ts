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

const CLAUDE_RUNNER = { v: 1 as const, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default' } };
const CODEX_KEY = 'agent:happier.agent.codex/codex';

async function generate() {
    const { generateScmCommitMessage } = await import('./commitMessageGenerator');
    return await generateScmCommitMessage({
        host: { kind: 'session', sessionId: 'sess_1' },
        choice: CLAUDE_RUNNER,
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
            choice: CLAUDE_RUNNER, scopePaths: ['file ', ' ', ''],
        })).toMatchObject({ ok: true, message: 'feat: update stuff' });
        expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({
            cwd: '/repo', kind: 'scm_commit_message.v1', intent: 'scm_commit_message', permissionMode: 'no_tools',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            intentInput: { scope: { kind: 'paths', include: ['file ', ' '] } },
        }), expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a', exactMachineId: 'machine_a' }));
        expect(executionRunGet).not.toHaveBeenCalled();
        expect(executionRunWait).toHaveBeenCalledWith(null, expect.objectContaining({ runId: 'run_1' }),
            expect.objectContaining({ serverId: 'home_a', targetMachineId: 'machine_a' }));
        actionExecuteMock.mockReset();
    });

    it('starts the explicit runner as chosen: its model, connected route and effort, never tool-capable', async () => {
        const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
        const executionRunWait = vi.fn(async () => ({ ok: true as const, status: 'succeeded' as const, result: successfulTerminalResult().result }));
        const agentsModelsList = vi.fn(async () => ({ items: [] }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            executionRunCheckProtocolV2: async (_sessionId, _requirements, opts) => ({ ok: true, exactMachineId: opts?.targetMachineId ?? undefined }),
            executionRunStart, executionRunWait, agentsModelsList,
        }));
        actionExecuteMock.mockImplementation(executor.execute);
        const { generateScmCommitMessage } = await import('./commitMessageGenerator');
        const choice = { v: 1 as const, modelSelection: { agentTargetKey: CODEX_KEY, providerConnectionId: null, modelId: 'gpt-6-luna' },
            connectedServices: null, sessionConfigOptionOverrides: { v: 1 as const, updatedAt: 1, overrides: { reasoning_effort: { value: 'low', updatedAt: 1 } } },
            permissionMode: 'full' as const };
        expect(await generateScmCommitMessage({
            host: { kind: 'workspace', workspace: { serverId: 'home_a', workspaceId: 'workspace_a', machineId: 'machine_a', rootPath: '/repo' } },
            choice, scopePaths: ['a.txt'],
        })).toMatchObject({ ok: true, message: 'feat: update stuff' });
        expect(agentsModelsList).not.toHaveBeenCalled();
        expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({
            modelSelection: choice.modelSelection, connectedServices: null,
            sessionConfigOptionOverrides: choice.sessionConfigOptionOverrides, permissionMode: 'no_tools',
        }), expect.anything());
    });

    it('resolves Auto on the executing machine, then starts the runner its owner picked', async () => {
        const runner = { v: 1, modelSelection: { agentTargetKey: CODEX_KEY, providerConnectionId: null, modelId: 'gpt-6-luna' }, permissionMode: 'no_tools' };
        const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
        const executionRunWait = vi.fn(async () => ({ ok: true as const, status: 'succeeded' as const, result: successfulTerminalResult().result }));
        const agentsModelsList = vi.fn(async () => ({ items: [], llmTaskRunner: { ok: true, source: 'auto', runner, title: 'GPT-6-Luna' } }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            executionRunCheckProtocolV2: async (_sessionId, _requirements, opts) => ({ ok: true, exactMachineId: opts?.targetMachineId ?? undefined }),
            executionRunStart, executionRunWait, agentsModelsList,
        }));
        actionExecuteMock.mockImplementation(executor.execute);
        const { generateScmCommitMessage } = await import('./commitMessageGenerator');
        expect(await generateScmCommitMessage({
            host: { kind: 'workspace', workspace: { serverId: 'home_a', workspaceId: 'workspace_a', machineId: 'machine_a', rootPath: '/repo' } },
            choice: null, scopePaths: ['a.txt'],
        })).toMatchObject({ ok: true, message: 'feat: update stuff' });
        expect(agentsModelsList).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'llm_task_runner', task: 'scm_commit_message', machineId: 'machine_a' }), expect.anything());
        expect(executionRunStart).toHaveBeenCalledWith(null, expect.objectContaining({ modelSelection: runner.modelSelection, permissionMode: 'no_tools' }), expect.anything());
    });

    it('returns a typed failure and starts nothing when no Agent on the machine is ready', async () => {
        const executionRunStart = vi.fn();
        const agentsModelsList = vi.fn(async () => ({ items: [], llmTaskRunner: { ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE',
            reason: 'no_ready_agent', unavailableAgents: [{ agentTargetKey: CODEX_KEY, reason: 'sign_in_required' }] } }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ executionRunStart, agentsModelsList }));
        actionExecuteMock.mockImplementation(executor.execute);
        const { generateScmCommitMessage } = await import('./commitMessageGenerator');
        expect(await generateScmCommitMessage({
            host: { kind: 'workspace', workspace: { serverId: 'home_a', workspaceId: 'workspace_a', machineId: 'machine_a', rootPath: '/repo' } },
            choice: { v: 1, mode: 'auto' }, scopePaths: [],
        })).toMatchObject({ ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE' });
        expect(executionRunStart).not.toHaveBeenCalled();
    });

    it('resolves Auto for a Session-hosted commit on the Session machine with the Session own Agent', async () => {
        const executionRunStart = vi.fn();
        const agentsModelsList = vi.fn(async () => ({ items: [], llmTaskRunner: { ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE',
            reason: 'no_ready_agent', unavailableAgents: [] } }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ executionRunStart, agentsModelsList }));
        actionExecuteMock.mockImplementation(executor.execute);
        const { generateScmCommitMessage } = await import('./commitMessageGenerator');
        expect(await generateScmCommitMessage({
            host: { kind: 'session', sessionId: 'sess_1', serverId: 'home_a', machineId: 'machine_s', agentTargetKey: CODEX_KEY },
            choice: null, scopePaths: [],
        })).toMatchObject({ ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE' });
        expect(agentsModelsList).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'llm_task_runner', task: 'scm_commit_message',
            machineId: 'machine_s', sessionAgentTargetKey: CODEX_KEY }), expect.anything());
        expect(executionRunStart).not.toHaveBeenCalled();
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
                modelSelection: CLAUDE_RUNNER.modelSelection,
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
        }, 'pending'],
        ['cancelled', { ok: false, code: 'cancelled' }, 'unknown'],
    ] as const)('returns the canonical %s observation result without redispatching or stopping', async (errorCode, wait, outcome) => {
        actionExecuteMock.mockResolvedValueOnce(startResult(wait));

        await expect(generate()).resolves.toMatchObject({ ok: false, errorCode, runId: 'run_1', outcome });

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
            : { ok: false });

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
