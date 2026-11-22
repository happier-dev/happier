import { beforeEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
// The UI transport adapter delegates into the real Action executor; only its host ports are fixtures.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => execute }));
import { suggestDeploySetup } from './suggestDeploySetup';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

const catalog: DeploySuggestionCatalogV1 = {
    starters: [{ id: 'website', title: 'Website', deploy: { framework: 'html', output: 'static' } }],
    apps: [], stores: [], forges: [{ providerKind: 'github', title: 'GitHub' }],
    targets: [{ id: 'own', title: 'Own server', targetClass: 'ownServer', availability: 'available', accepts: ['static'], needs: [], sources: { gitIntegration: ['github'], upload: false } }],
    machines: [
        { machineId: 'offline', label: 'Offline', online: false, readiness: 'unknown', homeDir: '/home/offline' },
        { machineId: 'signed-out', label: 'Signed out', online: true, readiness: 'unknown', homeDir: '/home/alice' },
        { machineId: 'ready', label: 'Dev box', online: true, readiness: 'ready', homeDir: '/home/alice' },
        { machineId: 'unused', label: 'Other box', online: true, readiness: 'ready', homeDir: '/home/alice' },
    ],
};
const recommendation = { source: { kind: 'starter', starterId: 'website' }, targetId: 'own', title: 'Bakery website', why: 'It fits what you described.', whatToBuild: 'Bakery website',
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
    // The dialog validates against the catalog it gave the model, through the check's own validator: no check call.
    expect(execute.mock.calls.map(row => row[0])).toEqual(['agents.models.list', 'agents.models.list', 'execution.run.start']);
    expect(progress).toContainEqual(expect.objectContaining({ kind: 'run', runId: 'run_1', machineId: 'ready' }));
    const start = execute.mock.calls.find(row => row[0] === 'execution.run.start')!;
    // A no-tools task runs in the Machine's home folder, which always exists (F-CWD: `<home>/src` may not).
    expect(start[1]).toMatchObject({ sessionId: null, cwd: '/home/alice', permissionMode: 'no_tools',
        intentInput: { input: { description: '  Bakery\n', catalog } } });
});

it('reads one catalog for a question round and reuses it for the answered run', async () => {
    const questions = { kind: 'questions', questions: [{ id: 'purpose', type: 'text', prompt: 'What should visitors do?' },
        { id: 'size', type: 'singleChoice', prompt: 'How big?', choices: [{ id: 'small' }] }] };
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
        deploymentSuggestionForges: async () => catalog.forges,
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
    // The step presents canonical questions: author defaults are filled once, and an unlabelled choice reads as its id.
    expect(first.questions.questions).toEqual([
        { id: 'purpose', type: 'text', prompt: 'What should visitors do?', required: false },
        { id: 'size', type: 'singleChoice', prompt: 'How big?', required: false, allowCustom: false,
            choices: [{ id: 'small', label: 'small' }] },
    ]);
    expect(await suggestDeploySetup({ serverId: 'home', description: 'Bakery', catalog: first.catalog, answers, note: 'Keep it simple' }))
        .toMatchObject({ kind: 'recommendations', recommendations: [catalogRecommendation] });
    expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.catalog')).toHaveLength(1);
    expect(execute.mock.calls.filter(row => row[0] === 'execution.run.start')).toHaveLength(2);
    expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.check')).toHaveLength(0);
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
        machines: [
            { machineId: 'offline', online: false, reason: 'offline', unavailableAgents: [] },
            { machineId: 'signed-out', online: true, reason: 'no_ready_agent',
                unavailableAgents: [{ agentTargetKey: runner.modelSelection.agentTargetKey, reason: 'sign_in_required' }] },
            { machineId: 'ready', online: true, reason: 'no_ready_agent',
                unavailableAgents: [{ agentTargetKey: runner.modelSelection.agentTargetKey, reason: 'sign_in_required' }] },
            { machineId: 'unused', online: true, reason: 'no_ready_agent',
                unavailableAgents: [{ agentTargetKey: runner.modelSelection.agentTargetKey, reason: 'sign_in_required' }] },
        ] });
    const runnerReads = execute.mock.calls.filter(row => row[0] === 'agents.models.list');
    expect(runnerReads.map(row => row[1].machineId)).toEqual(['signed-out', 'ready', 'unused']);
    expect(execute.mock.calls.filter(row => row[0] === 'execution.run.start')).toHaveLength(0);
    expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.check')).toHaveLength(0);
});

it('surfaces an explicit no-tools refusal through the existing per-Machine repair result', async () => {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ agentsModelsList: async () => ({ llmTaskRunner: {
        ok: false, errorCode: 'LLM_TASK_RUNNER_UNAVAILABLE', reason: 'no_matching_model', unavailableAgents: [],
    } }) }));
    execute.mockImplementation(executor.execute);
    const choice = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.muse/muse', providerConnectionId: null,
        modelId: 'meta/muse-spark-1.3-contributor' } } as const;
    expect(await suggestDeploySetup({ serverId: 'home', description: 'Bakery', choice,
        catalog: { ...catalog, machines: catalog.machines.filter(machine => machine.machineId === 'ready') },
    })).toMatchObject({ kind: 'noAgent', machines: [{ machineId: 'ready', reason: 'no_matching_model' }] });
    expect(execute.mock.calls.map(row => row[0])).toEqual(['agents.models.list']);
});

it.each([false, true])('stops the accepted run once without hiding Stop failure (refused: %s)', async (refused) => {
    const abort = new AbortController();
    let stops = 0;
    const resolvedRunner = { ...runner, permissionMode: 'no_tools' } as const;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        agentsModelsList: async () => ({ llmTaskRunner: { ok: true, source: 'explicit', runner: resolvedRunner } }),
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
            ? { kind: 'failed', code: 'stop_refused', stage: 'run', runner: resolvedRunner } : { kind: 'stopped' });
    expect(stops).toBe(1);
    expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.check')).toHaveLength(0);
});

it.each([false, true])('reads the catalog only once registry sources settle, so starters are not silently missing (stopped: %s)', async (stopped) => {
    // The app shell's publication says a Machine still owes its registry sources (F-STARTERS-RACE).
    let pending = true;
    const listeners = new Set<() => void>();
    const unpublish = publishCommittedAppShellPluginUiProjection(() => null, undefined,
        listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, undefined, undefined, () => pending);
    try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            registryActionExecute: async ({ input }) => {
                const kind = (input as { kind: string }).kind;
                return { pages: [{ sourceId: kind, status: { state: 'ok', fetchedAt: 1 }, nextCursor: null,
                    items: kind === 'starter' && !pending ? [{ sourceId: kind, kind: 'starter', itemId: 'website', title: 'Website',
                        starterDeploy: { framework: 'html', output: 'static' } }] : [] }] };
            },
            connectedServiceAction: async () => ({ accounts: [], pools: [], healthBasis: 'credentials',
                source: { completeness: 'complete', observedAtMs: 1 } }),
            machinesList: async () => ({ items: [] }),
            deploymentSuggestionTargets: async () => ({ targets: catalog.targets, stores: [] }),
            deploymentSuggestionForges: async () => catalog.forges,
            machineSetupPlan: async () => ({ targets: [] }),
        }));
        execute.mockImplementation(executor.execute);
        const abort = new AbortController();
        const progress: unknown[] = [];
        const result = suggestDeploySetup({ serverId: 'home', description: 'Bakery', signal: abort.signal,
            onProgress: event => progress.push(event) });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.catalog')).toHaveLength(0);
        if (stopped) {
            abort.abort();
            expect(await result).toEqual({ kind: 'stopped' });
            expect(execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.catalog')).toHaveLength(0);
            return;
        }
        pending = false;
        for (const listener of listeners) listener();
        expect(await result).toMatchObject({ kind: 'noAgent' });
        expect(progress[0]).toMatchObject({ kind: 'catalog', counts: { starters: 1 } });
    } finally { unpublish(); }
});

// F-WAIT (AUTO-LIVE run_4e61a18e-59f9-4999-ab60-3025c6f86fa2): "Looking at your Store" held ~2.5 min while one
// Machine still owed its registry sources, although the Store already held the starters. The registry selection
// never waits once a source of the kind it lists is known; the catalog read follows the same rule.
it('reads the catalog at once when a starter source is already known, though another Machine still owes its sources', async () => {
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { projectPluginRegistrySourceDeclarationV1 } = await import('@happier-dev/protocol/registries');
    const starters = projectPluginRegistrySourceDeclarationV1({ pluginId: 'happier.deployment.templates', pluginVersion: '1.0.0',
        definition: { id: 'starters', title: 'Starters', format: 'happier-catalog', kinds: ['starter'], url: 'https://starters.test/catalog.json' } });
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, registrySourcesById: { [starters.id]: starters } };
    const unpublish = publishCommittedAppShellPluginUiProjection(() => projection, undefined, () => () => {},
        undefined, undefined, () => true);
    try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            registryActionExecute: async ({ input }) => ({ pages: [{ sourceId: (input as { kind: string }).kind,
                status: { state: 'ok', fetchedAt: 1 }, nextCursor: null, items: [] }] }),
            connectedServiceAction: async () => ({ accounts: [], pools: [], healthBasis: 'credentials',
                source: { completeness: 'complete', observedAtMs: 1 } }),
            machinesList: async () => ({ items: [] }),
            deploymentSuggestionTargets: async () => ({ targets: catalog.targets, stores: [] }),
            deploymentSuggestionForges: async () => catalog.forges,
            machineSetupPlan: async () => ({ targets: [] }),
        }));
        execute.mockImplementation(executor.execute);
        const abort = new AbortController();
        const result = suggestDeploySetup({ serverId: 'home', description: 'Bakery', signal: abort.signal });
        await new Promise(resolve => setTimeout(resolve, 0));
        const catalogReads = execute.mock.calls.filter(row => row[0] === 'deployments.suggestions.catalog').length;
        abort.abort();
        await result;
        expect(catalogReads, 'the catalog read does not wait on a Machine that can only add more starters').toBe(1);
    } finally { unpublish(); }
});

// AUTO-HUNT pattern 1: a cold load lists online Machines whose records are still opening (no name, no home yet). Such a
// Machine is not "unavailable": the suggestion waits for its owner to open it, then runs there in its home.
it('waits for an online Machine whose record is still opening instead of calling it unavailable', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { createMachineFixture } = await import('@/dev/testkit');
    const opened = createMachineFixture({ id: 'opening', active: true, activeAt: Date.now() });
    storage.getState().applyMachines([{ ...opened, metadata: null, availability: undefined }], true, { sourceServerId: 'home' });
    let starts = 0;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        agentsModelsList: async () => ({ llmTaskRunner: { ok: true, source: 'auto', runner, title: 'Claude' } }),
        executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'opening' }),
        executionRunStart: async () => { starts++; return { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }; },
        executionRunWait: async () => ({ ok: true, status: 'succeeded', result: terminal({ recommendations: [recommendation] }) }),
    }));
    execute.mockImplementation(executor.execute);
    try {
        // The catalog leaves out the name and home of a row its owner had not opened yet.
        const result = suggestDeploySetup({ serverId: 'home', description: 'Bakery',
            catalog: { ...catalog, machines: [{ machineId: 'opening', online: true, readiness: 'unknown' }] } });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(starts, 'nothing runs before the Machine has a home').toBe(0);
        storage.getState().applyMachines([opened], false, { sourceServerId: 'home' });
        expect(await result).toMatchObject({ kind: 'recommendations', recommendations: [recommendation] });
        expect(execute.mock.calls.find(row => row[0] === 'execution.run.start')![1]).toMatchObject({ cwd: opened.metadata!.homeDir });
    } finally { storage.setState(storage.getInitialState(), true); }
});
