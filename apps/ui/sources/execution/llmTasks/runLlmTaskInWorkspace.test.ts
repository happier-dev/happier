import { beforeEach, it, expect, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
import { resolveWorkspaceLlmTaskRunner, runLlmTaskInWorkspace } from './runLlmTaskInWorkspace';

const host = { kind: 'workspace', workspace: { serverId: 'home_a', machineId: 'machine_a', rootPath: '/projects' } } as const;
const runner = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default' } } as const;
const resolvedRunner = { ...runner, permissionMode: 'no_tools' } as const;
beforeEach(() => { execute.mockReset(); });
it('reports the accepted task run before waiting so Stop can reach it, without a Session or another start', async () => {
    const events: string[] = [];
    const terminal = { run: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1', intent: 'task',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'no_tools', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
        latestToolResult: { recommendations: [] } };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        agentsModelsList: async () => ({ items: [], llmTaskRunner: { ok: true, source: 'explicit', runner: resolvedRunner } }),
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine_a' }),
        executionRunStart: async () => { events.push('start'); return { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }; },
        executionRunWait: async () => { events.push('wait'); return { ok: true, status: 'succeeded', result: terminal }; },
    }));
    execute.mockImplementation(executor.execute);
    const result = await runLlmTaskInWorkspace({
        host,
        choice: runner,
        task: 'deploy_suggestion', intent: 'task', instructions: 'Suggest a setup', intentInput: { input: { description: 'Bakery' } },
        onStarted: runId => { events.push(runId); },
    });
    expect(result).toMatchObject({ ok: true, terminal });
    expect(events).toEqual(['start', 'run_1', 'wait']);
    expect(execute.mock.calls.map(row => row[0])).toEqual(['agents.models.list', 'execution.run.start']);
});

it.each(['beforeAcceptance', 'onStarted', 'wait'] as const)('stops an accepted task exactly once when aborted during %s', async phase => {
    const controller = new AbortController();
    const stop = vi.fn<NonNullable<ActionExecutorDeps['executionRunStop']>>(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine_a' }),
        executionRunStart: async () => {
            if (phase === 'beforeAcceptance') controller.abort();
            return { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' };
        },
        executionRunWait: async () => {
            if (phase === 'wait') controller.abort();
            return { ok: false, code: 'cancelled' };
        },
        executionRunStop: stop,
    }));
    execute.mockImplementation(executor.execute);
    const result = await runLlmTaskInWorkspace({ host, choice: runner, resolvedRunner, task: 'deploy_suggestion', intent: 'task',
        instructions: 'Suggest a setup', intentInput: { input: { description: 'Bakery' } }, signal: controller.signal,
        onStarted: () => { if (phase === 'onStarted') controller.abort(); },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'cancelled', runId: 'run_1' });
    expect(stop).toHaveBeenCalledExactlyOnceWith(null, { runId: 'run_1' }, expect.objectContaining({
        serverId: 'home_a', targetMachineId: 'machine_a',
    }));
    expect(stop.mock.calls[0]?.[2]?.signal).toBeUndefined();
    expect(execute.mock.calls.map(row => row[0])).toEqual(['execution.run.start', 'execution.run.stop']);
});

it('preserves a failed Stop instead of reporting cancellation', async () => {
    const controller = new AbortController();
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine_a' }),
        executionRunStart: async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }),
        executionRunWait: async () => ({ ok: false, code: 'cancelled' }),
        executionRunStop: async () => ({ ok: false, errorCode: 'machine_offline', error: 'The Machine is offline' }),
    }));
    execute.mockImplementation(executor.execute);
    expect(await runLlmTaskInWorkspace({ host, choice: runner, resolvedRunner, task: 'deploy_suggestion', intent: 'task',
        instructions: 'Suggest a setup', intentInput: { input: { description: 'Bakery' } }, signal: controller.signal,
        onStarted: () => controller.abort(),
    })).toMatchObject({ ok: false, errorCode: 'machine_offline', error: 'The Machine is offline', runId: 'run_1', outcome: 'unknown' });
});

it('starts nothing when the task was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    execute.mockResolvedValue({ ok: false, errorCode: 'execution_run_target_unavailable', error: 'Machine unavailable' });
    expect(await runLlmTaskInWorkspace({ host, choice: runner, task: 'deploy_suggestion', intent: 'task',
        instructions: 'Suggest a setup', intentInput: { input: { description: 'Bakery' } }, signal: controller.signal,
    })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(execute).not.toHaveBeenCalled();
});

it('uses an already resolved runner without another model inventory read', async () => {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine_a' }),
        executionRunStart: async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }),
        executionRunWait: async () => ({ ok: true, status: 'running', disposition: 'observation_timeout',
            runId: 'run_1', timeoutMs: 12_000, observedAtMs: 13_000, deadlineAtMs: 13_000 }),
    }));
    execute.mockImplementation(executor.execute);
    expect(await runLlmTaskInWorkspace({ host, choice: null, resolvedRunner: runner, task: 'deploy_suggestion', intent: 'task',
        instructions: 'Suggest a setup', intentInput: { input: { description: 'Bakery' } },
    })).toMatchObject({ ok: false, errorCode: 'timeout', runId: 'run_1', outcome: 'pending' });
    expect(execute.mock.calls.map(row => row[0])).toEqual(['execution.run.start']);
});

it('starts a detached task with the resolved brokered Team credential', async () => {
    const selection = { source: 'team_resource', agentTargetKey: runner.modelSelection.agentTargetKey, modelId: 'team-model',
        teamId: 'team_a', resourceId: 'resource_a', expectedResourceRevision: 7, deliveryMode: 'brokered' } as const;
    const start = vi.fn<NonNullable<ActionExecutorDeps['executionRunStart']>>(async () =>
        ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'machine_a' }),
        executionRunStart: start,
        executionRunWait: async () => ({ ok: true, status: 'running', disposition: 'observation_timeout',
            runId: 'run_1', timeoutMs: 12_000, observedAtMs: 13_000, deadlineAtMs: 13_000 }),
    }));
    execute.mockImplementation(executor.execute);
    await runLlmTaskInWorkspace({ host, choice: null, resolvedRunner: { v: 1, modelSelection: selection },
        task: 'deploy_suggestion', intent: 'task', instructions: 'Suggest a setup', intentInput: { input: { description: 'Bakery' } } });
    expect(start).toHaveBeenCalledWith(null, expect.objectContaining({ teamCredentialModel: expect.objectContaining({
        resourceId: 'resource_a', teamId: 'team_a', expectedResourceRevision: 7, deliveryMode: 'brokered', modelId: 'team-model',
    }) }), expect.anything());
});

it('retains the canonical runner title and unavailable Agent reasons', async () => {
    const unavailableAgents = [{ agentTargetKey: runner.modelSelection.agentTargetKey, reason: 'sign_in_required' as const }];
    let ready = false;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        agentsModelsList: async () => ({ items: [], llmTaskRunner: ready
            ? { ok: true, source: 'auto', runner, title: 'Claude' }
            : { ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_ready_agent', unavailableAgents } }),
    }));
    execute.mockImplementation(executor.execute);
    expect(await resolveWorkspaceLlmTaskRunner(host, null, 'deploy_suggestion')).toMatchObject({
        ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_ready_agent', unavailableAgents,
    });
    ready = true;
    expect(await resolveWorkspaceLlmTaskRunner(host, null, 'deploy_suggestion')).toMatchObject({ ok: true, runner, title: 'Claude' });
});
