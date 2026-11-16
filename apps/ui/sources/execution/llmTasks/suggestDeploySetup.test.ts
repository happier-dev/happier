import { beforeEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
// The UI transport adapter delegates into the real Action executor; only its host ports are fixtures.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
import { suggestDeploySetup } from './suggestDeploySetup';

const catalog: DeploySuggestionCatalogV1 = {
    starters: [{ id: 'website', title: 'Website', deploy: { framework: 'html', output: 'static' } }],
    apps: [], stores: [],
    targets: [{ id: 'own', title: 'Own server', targetClass: 'ownServer', availability: 'available', accepts: ['static'], needs: [] }],
    machines: [
        { machineId: 'offline', label: 'Offline', online: false, readiness: 'unknown', homeDir: '/home/offline' },
        { machineId: 'signed-out', label: 'Signed out', online: true, readiness: 'unknown', homeDir: '/home/alice' },
        { machineId: 'ready', label: 'Dev box', online: true, readiness: 'ready', homeDir: '/home/alice' },
        { machineId: 'unused', label: 'Other box', online: true, readiness: 'ready', homeDir: '/home/alice' },
    ],
};
const recommendation = { source: { kind: 'starter', starterId: 'website' }, targetId: 'own', whatToBuild: 'Bakery website',
    stack: { framework: 'html', output: 'static' }, data: { kind: 'none' }, variables: [] };
const runner = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default' } } satisfies LlmTaskRunnerConfigV1;
const terminal = (output: unknown) => ({ run: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1', intent: 'task',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'no_tools', retentionPolicy: 'ephemeral',
    runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 }, latestToolResult: output });

beforeEach(() => { execute.mockReset(); });

it('uses the first ready online Machine once and checks model output against the held catalog', async () => {
    const machines: string[] = [];
    let starts = 0;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        agentsModelsList: async args => {
            machines.push(args.machineId ?? '');
            return { llmTaskRunner: args.machineId === 'signed-out' ? { ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE',
                reason: 'no_ready_agent', unavailableAgents: [{ agentTargetKey: runner.modelSelection.agentTargetKey, reason: 'sign_in_required' }] }
                : { ok: true, source: 'auto', runner, title: 'Claude' } };
        },
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'ready' }),
        executionRunStart: async () => { starts++; return { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }; },
        executionRunWait: async () => ({ ok: true, status: 'succeeded', result: terminal({ recommendations: [recommendation,
            { ...recommendation, targetId: 'invented' }] }) }),
    }));
    execute.mockImplementation(executor.execute);
    const progress: unknown[] = [];
    const result = await suggestDeploySetup({ serverId: 'home', description: '  Bakery\n', catalog,
        onProgress: event => progress.push(event) });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'recommendations', recommendations: [recommendation],
        dropped: [{ index: 1, reason: 'unknown_id' }], catalog });
    expect(machines).toEqual(['signed-out', 'ready']);
    expect(starts).toBe(1);
    expect(execute.mock.calls.map(row => row[0])).toEqual(['agents.models.list', 'agents.models.list', 'execution.run.start', 'deployments.suggestions.check']);
    expect(progress).toContainEqual(expect.objectContaining({ kind: 'run', runId: 'run_1', machineId: 'ready' }));
    const start = execute.mock.calls.find(row => row[0] === 'execution.run.start')!;
    expect(start[1]).toMatchObject({ sessionId: null, cwd: '/home/alice/src', permissionMode: 'no_tools',
        intentInput: { input: { description: '  Bakery\n', catalog } } });
});

it('reads one catalog for a question round and reuses it for the answered run', async () => {
    const questions = { kind: 'questions', questions: [{ id: 'purpose', type: 'text', prompt: 'What should visitors do?' }] };
    const answers = { purpose: { kind: 'text' as const, value: 'Order bread' } };
    const catalogRecommendation = { ...recommendation, source: { kind: 'starter', starterId: JSON.stringify(['starter', 'website']) } };
    let round = 0;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        registryActionExecute: async ({ input }) => {
            const kind = (input as { kind: string }).kind;
            return { pages: [{ sourceId: kind, status: { state: 'ok', fetchedAt: 1 }, nextCursor: null,
                items: kind === 'starter' ? [{ sourceId: kind, kind: 'starter', itemId: 'website', title: 'Website',
                    starterDeploy: { framework: 'html', output: 'static' } }] : [] }] };
        },
        connectedServiceAction: async () => ({ accounts: [], pools: [], healthBasis: 'credentials',
            source: { completeness: 'complete', observedAtMs: 1 } }),
        machinesList: async () => ({ items: [{ machineId: 'ready', label: 'Dev box', active: true, homeDir: '/home/alice' }] }),
        deploymentSuggestionTargets: async () => ({ targets: catalog.targets, stores: [] }),
        machineSetupPlan: async () => ({ targets: [] }),
        agentsModelsList: async () => ({ llmTaskRunner: { ok: true, source: 'auto', runner, title: 'Claude' } }),
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'ready' }),
        executionRunStart: async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }),
        executionRunWait: async () => ({ ok: true, status: 'succeeded', result: terminal(++round === 1
            ? { recommendations: [], questions } : { recommendations: [catalogRecommendation] }) }),
    }));
    execute.mockImplementation(executor.execute);
    const first = await suggestDeploySetup({ serverId: 'home', description: 'Bakery' });
    expect(first).toMatchObject({ kind: 'questions', questions });
    if (first.kind !== 'questions') throw new Error(JSON.stringify(first));
    expect(await suggestDeploySetup({ serverId: 'home', description: 'Bakery', catalog: first.catalog, answers, note: 'Keep it simple' }))
        .toMatchObject({ kind: 'recommendations', recommendations: [catalogRecommendation] });
    expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.catalog')).toHaveLength(1);
    expect(execute.mock.calls.filter(row => row[0] === 'execution.run.start')).toHaveLength(2);
    expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.check')).toHaveLength(2);
    expect(execute.mock.calls.filter(row => row[0] === 'execution.run.start')[1]![1])
        .toMatchObject({ intentInput: { input: { answers, note: 'Keep it simple' } } });
});

it('returns per-Machine repair reasons without starting a run when no Agent is ready', async () => {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ agentsModelsList: async () => ({ llmTaskRunner: {
        ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_ready_agent', unavailableAgents: [
            { agentTargetKey: runner.modelSelection.agentTargetKey, reason: 'sign_in_required' }],
    } }) }));
    execute.mockImplementation(executor.execute);
    expect(await suggestDeploySetup({ serverId: 'home', description: 'Bakery', catalog })).toMatchObject({ kind: 'noAgent',
        machines: expect.arrayContaining([expect.objectContaining({ machineId: 'offline', online: false, reason: 'offline' }),
            expect.objectContaining({ machineId: 'signed-out', online: true, reason: 'no_ready_agent',
                unavailableAgents: [expect.objectContaining({ reason: 'sign_in_required' })] })]) });
    expect(execute.mock.calls.filter(row => row[0] === 'execution.run.start')).toHaveLength(0);
});

it.each([false, true])('stops the accepted run once without hiding Stop failure (refused: %s)', async (refused) => {
    const abort = new AbortController();
    let stops = 0;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'ready' }),
        executionRunStart: async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }),
        executionRunStop: async () => { stops++; return refused
            ? { ok: false, errorCode: 'stop_refused', error: 'Stop refused' } : { ok: true }; },
        executionRunWait: async () => ({ ok: true, status: 'succeeded', result: terminal({ recommendations: [recommendation] }) }),
    }));
    execute.mockImplementation(executor.execute);
    expect(await suggestDeploySetup({ serverId: 'home', description: 'Bakery',
        catalog: { ...catalog, machines: catalog.machines.filter(machine => machine.machineId === 'ready') }, choice: runner, signal: abort.signal,
        onProgress: event => { if (event.kind === 'run') abort.abort(); } })).toEqual(refused
            ? { kind: 'failed', code: 'stop_refused' } : { kind: 'stopped' });
    expect(stops).toBe(1);
    expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.check')).toHaveLength(0);
});
