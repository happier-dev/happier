import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition, type WorkflowDefinitionV1, type WorkflowCondition } from '@happier-dev/protocol/workflows';
import {  type WorkflowStepExecutor } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { WorkflowInputResolutionError } from './input';

const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } as const;
const workspace = { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' };
const step = (id: string) => ({ kind: 'step' as const, id, document: { text: id, references: [], attachments: [] },
  input: [], result: { kind: 'text' as const }, execution: { conversation: { kind: 'fresh' as const } } });
const outcome = { kind: 'result' as const, producer: { blockId: 'rounds', scope: { kind: 'current' as const } }, path: ['outcome'] };
const run = (definition: WorkflowDefinitionV1) => ({ runId: 'loop-run', definition, inputs: {},
  executionTarget: { kind: 'session' as const }, authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const } });
const workflow = (blocks: WorkflowDefinitionV1['blocks']): WorkflowDefinitionV1 => ({ version: 1, inputs: [], defaults: { agentTarget }, blocks });
const deps = (store: ReturnType<typeof createInMemoryWorkflowCoordinatorStore>, executeStep: WorkflowStepExecutor) => ({
  store, executeStep, resolveWorkspace: async () => ({ ok: true as const, workspace }),
});
const closingOutcome = (store: ReturnType<typeof createInMemoryWorkflowCoordinatorStore>) =>
  [...store.records.values()].find((row) => row.blockId === 'rounds' && !row.frame)?.container?.closing;

describe('workflow loop outcomes', () => {
  it('retains a child round bound after live context changes during reclaim', async () => {
    const first = createInMemoryWorkflowCoordinatorStore();
    const childRef = 'builtin:repair';
    const child: WorkflowDefinitionV1 = { ...workflow([{ kind: 'loop', id: 'rounds', body: [step('work')], repetition: {
      kind: 'until', maxIterations: { kind: 'input', name: 'rounds' },
      stopWhen: { kind: 'exists', value: { kind: 'input', name: 'missing' } },
    } }]), inputs: [{ name: 'rounds', valueType: 'number', required: true }, { name: 'missing', valueType: 'boolean', required: false }] };
    const definition = workflow([{ kind: 'workflow', id: 'child', workflowRef: childRef,
      input: { rounds: { kind: 'session_context_field', field: 'goal.tokenBudget' } } }]);
    const selection = { agentTarget, conversation: { kind: 'fresh' as const } };
    const input = { ...run(definition), originSessionId: 'origin', frozenChildren: { [childRef]: child }, materializedLeaves: [
      { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: 'child', kind: 'workflow' as const, childRef, selection, executionTarget: { kind: 'session' as const } },
      { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: childRef, blockId: 'work', kind: 'step' as const, selection, executionTarget: { kind: 'session' as const } },
    ] };
    let contextReads = 0;
    let crash = true;
    const options = (store: typeof first) => ({ ...deps(store, async (params) => {
      if (crash && params.iteration?.index === 1) { crash = false; throw new Error('crash-child'); }
      expect(params.iteration?.count).toBe(2);
      await params.beforeInputAdmission();
      return { kind: 'completed' as const, result: 'worked' };
    }), sessionContext: { resolveSessionContextField: async () => ++contextReads === 1 ? 2 : 5 } });
    await expect(createWorkflowCoordinator(options(first)).run(input)).rejects.toThrow('crash-child');
    const restarted = createInMemoryWorkflowCoordinatorStore();
    for (const [key, row] of first.records) restarted.records.set(key, row);
    await expect(createWorkflowCoordinator(options(restarted)).run(input)).resolves.toEqual({ state: 'succeeded' });
    expect(contextReads).toBe(1);
    expect(closingOutcome(restarted)).toMatchObject({ outcome: { kind: 'exhausted', rounds: 2 } });
  });
  it('freezes independent child round inputs at each inline admission and reuses them on restart', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const childRef = 'builtin:repair';
    const child: WorkflowDefinitionV1 = { ...workflow([{ kind: 'loop', id: 'rounds', body: [step('work')], repetition: {
      kind: 'until', maxIterations: { kind: 'input', name: 'rounds' },
      stopWhen: { kind: 'exists', value: { kind: 'input', name: 'missing' } },
    } }]), inputs: [{ name: 'rounds', valueType: 'number', required: true }, { name: 'missing', valueType: 'boolean', required: false }],
      finalOutput: outcome };
    const nested = (id: string, rounds: number) => ({ kind: 'workflow' as const, id, workflowRef: childRef,
      input: { rounds: { kind: 'literal' as const, value: rounds } } });
    const definition = workflow([nested('first', 2), nested('second', 3)]);
    const selection = { agentTarget, conversation: { kind: 'fresh' as const } };
    const frozenChildren = { [childRef]: child };
    const materializedLeaves = [
      ...['first', 'second'].map((blockId) => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId, kind: 'workflow' as const, childRef, selection, executionTarget: { kind: 'session' as const } })),
      { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: childRef, blockId: 'work', kind: 'step' as const, selection, executionTarget: { kind: 'session' as const } },
    ];
    let executed = 0;
    const execute: WorkflowStepExecutor = async (params) => {
      executed += 1;
      await params.beforeInputAdmission();
      return { kind: 'completed', result: 'worked' };
    };
    const input = { ...run(definition), frozenChildren, materializedLeaves };
    await expect(createWorkflowCoordinator(deps(store, execute)).run(input)).resolves.toEqual({ state: 'succeeded' });
    expect(executed).toBe(5);
    expect([...store.records.values()].filter((row) => row.blockId === 'rounds' && !row.frame).map((row) => row.container?.closing?.outcome))
      .toEqual([{ kind: 'exhausted', rounds: 2 }, { kind: 'exhausted', rounds: 3 }]);
    expect(child.blocks[0]).toMatchObject({ repetition: { maxIterations: { kind: 'input', name: 'rounds' } } });
    const restarted = createInMemoryWorkflowCoordinatorStore();
    for (const [key, row] of store.records) restarted.records.set(key, row);
    await expect(createWorkflowCoordinator(deps(restarted, async () => { throw new Error('replayed effect'); })).run(input))
      .resolves.toEqual({ state: 'succeeded' });
    const invalid = { ...input, definition: workflow([nested('first', 0)]) };
    await expect(createWorkflowCoordinator(deps(createInMemoryWorkflowCoordinatorStore(), async () => { throw new Error('admitted invalid child'); }))
      .run(invalid)).resolves.toMatchObject({ state: 'failed', reason: 'invalid_input' });
  });
  it.each(['done', 'stuck', 'stop', 'legacy_stop'] as const)('records %s, then consumes the outcome after restart', async (terminal) => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const legacy = terminal === 'legacy_stop';
    const value = legacy ? 'stop' : terminal;
    const expectedOutcome = { kind: 'decision', value, ...(legacy ? {} : { reason: 'no progress' }) };
    const decisions = value === 'stop' ? ['continue', 'stop'] : ['continue', 'done', 'stuck'];
    const definition = workflow([{ kind: 'loop', id: 'rounds', body: [step('work')], repetition: {
      kind: 'evaluate', maxIterations: 4, history: 'all', evaluator: { ...step('judge'), result: { kind: 'decision', decisions } },
    } }, { kind: 'if', id: 'finished', when: { kind: 'compare', operator: 'eq', left: outcome,
      right: { kind: 'literal', value: expectedOutcome } },
      then: [step('matched')], otherwise: [step('wrong')] }]);
    expect(validateWorkflowDefinition(definition).valid).toBe(true);
    const executed: string[] = [];
    const execute: WorkflowStepExecutor = async (params) => {
      executed.push(params.step.id);
      await params.beforeInputAdmission();
      if (params.step.id === 'judge' && params.iteration!.index === 2 && !legacy) {
        expect(params.input.values).toContainEqual({ kind: 'evaluation_history', evaluations: [
          { decision: 'continue', reason: 'making progress' }, 'continue',
        ] });
      }
      return { kind: 'completed', resultEncoding: 'typed', result: params.step.id === 'judge'
        ? params.iteration!.index === 2 ? legacy ? 'stop' : { decision: value, reason: 'no progress' }
          : params.iteration!.index === 0 && !legacy ? { decision: 'continue', reason: 'making progress' } : 'continue' : 'worked' };
    };
    await expect(createWorkflowCoordinator(deps(store, execute)).run(run(definition))).resolves.toEqual({ state: 'succeeded' });
    expect(executed).toEqual(['work', 'judge', 'work', 'judge', 'work', 'judge', 'matched']);
    expect(closingOutcome(store)).toMatchObject({ outcome: expectedOutcome });
    const restarted = createInMemoryWorkflowCoordinatorStore();
    for (const [key, row] of store.records) restarted.records.set(key, row);
    await expect(createWorkflowCoordinator(deps(restarted, async () => { throw new Error('replayed effect'); })).run(run(definition)))
      .resolves.toEqual({ state: 'succeeded' });
    expect(closingOutcome(restarted)).toEqual(closingOutcome(store));
  });

  it.each(['until', 'evaluate'] as const)('succeeds after %s exhaustion and exposes rounds without replacing iteration results', async (kind) => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const repetition = kind === 'until'
      ? { kind, maxIterations: 2, stopWhen: { kind: 'exists' as const, value: { kind: 'input' as const, name: 'missing' } } }
      : { kind, maxIterations: 2, history: 'none' as const, evaluator: { ...step('judge'), result: { kind: 'decision' as const, decisions: ['continue', 'stop'] } } };
    const definition = { ...workflow([{ kind: 'loop', id: 'rounds', body: [step('work')], repetition },
      { ...step('consume'), input: [outcome, { ...outcome, path: [] }] }]),
      inputs: [{ name: 'missing', valueType: 'boolean' as const, required: false }] };
    expect(validateWorkflowDefinition(definition).valid).toBe(true);
    const values: unknown[] = [];
    const execute: WorkflowStepExecutor = async (params) => {
      if (params.step.id === 'consume') values.push(...params.input.values);
      await params.beforeInputAdmission();
      return { kind: 'completed', resultEncoding: 'typed', result: params.step.id === 'judge' ? 'continue' : 'worked' };
    };
    await expect(createWorkflowCoordinator(deps(store, execute)).run(run(definition))).resolves.toEqual({ state: 'succeeded' });
    expect(closingOutcome(store)).toMatchObject({ outcome: { kind: 'exhausted', rounds: 2 } });
    expect(values[0]).toEqual({ kind: 'exhausted', rounds: 2 });
    expect(values[1]).toHaveLength(2);
  });

  it.each([
    { verdicts: ['no_progress', 'no_progress', 'no_progress'], usage: undefined, arm: 2, rounds: 3 },
    { verdicts: ['no_progress'], usage: 100, arm: 1, rounds: 1 },
    { verdicts: ['done'], usage: 100, arm: 0, rounds: 1 },
    { verdicts: ['no_progress', 'progress', 'no_progress', 'no_progress', 'no_progress'], usage: undefined, arm: 2, rounds: 5 },
  ])('stops on deterministic done/budget/strikes $arm after $rounds checks across restart', async ({ verdicts, usage, arm, rounds }) => {
    const first = createInMemoryWorkflowCoordinatorStore();
    const stopWhen: WorkflowCondition = { kind: 'any', conditions: [
      { kind: 'compare', operator: 'eq', left: { kind: 'result', producer: { blockId: 'check', scope: { kind: 'current' } }, path: ['verdict'] }, right: { kind: 'literal', value: 'done' } },
      { kind: 'all', conditions: [
        { kind: 'exists', value: { kind: 'session_context_field', field: 'usage.tokensUsed' } },
        { kind: 'exists', value: { kind: 'session_context_field', field: 'goal.tokenBudget' } },
        { kind: 'compare', operator: 'gte', left: { kind: 'session_context_field', field: 'usage.tokensUsed' }, right: { kind: 'session_context_field', field: 'goal.tokenBudget' } },
      ] },
      { kind: 'compare', operator: 'gte', left: { kind: 'loop_trailing_count', producer: { blockId: 'check', scope: { kind: 'current' } }, path: ['verdict'], equals: 'no_progress' }, right: { kind: 'literal', value: 3 } },
    ] };
    const definition = workflow([{ kind: 'loop', id: 'rounds', repetition: { kind: 'until', maxIterations: 6, stopWhen },
      body: [{ ...step('check'), result: { kind: 'json', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } } }] }]);
    expect(validateWorkflowDefinition(definition).valid).toBe(true);
    let crash = rounds > 1;
    let checked = 0;
    let restartedConditions = false;
    let restartUsageReads = 0;
    const execute: WorkflowStepExecutor = async (params) => {
      checked += 1;
      await params.beforeInputAdmission();
      return { kind: 'completed', resultEncoding: 'typed', result: { verdict: verdicts[params.iteration!.index]! } };
    };
    const options = (store: typeof first) => ({ ...deps(store, execute), sessionContext: {
      resolveSessionContextField: async (field: string) => {
        if (crash && checked === rounds) { crash = false; throw new Error('crash-before-condition'); }
        if (field === 'goal.tokenBudget') return 100;
        // Late usage must not cause an already committed earlier iteration to
        // choose a different stop before the current iteration's strike check.
        if (restartedConditions && usage === undefined && restartUsageReads++ > 0) return 100;
        if (usage === undefined) throw new WorkflowInputResolutionError('missing_reference');
        return usage;
      },
    } });
    if (crash) {
      await expect(createWorkflowCoordinator(options(first)).run({ ...run(definition), originSessionId: 'origin' })).rejects.toThrow('crash-before-condition');
      const restarted = createInMemoryWorkflowCoordinatorStore();
      for (const [key, row] of first.records) restarted.records.set(key, row);
      restartedConditions = true;
      await expect(createWorkflowCoordinator(options(restarted)).run({ ...run(definition), originSessionId: 'origin' })).resolves.toEqual({ state: 'succeeded' });
      expect(closingOutcome(restarted)).toMatchObject({ outcome: { kind: 'stop_condition', arm } });
    } else {
      await expect(createWorkflowCoordinator(options(first)).run({ ...run(definition), originSessionId: 'origin' })).resolves.toEqual({ state: 'succeeded' });
      expect(closingOutcome(first)).toMatchObject({ outcome: { kind: 'stop_condition', arm } });
    }
    expect(checked).toBe(rounds);
  });

  it('records no arm for a non-any condition and never reevaluates a committed stop', async () => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const definition = workflow([{ kind: 'loop', id: 'rounds', body: [step('work')], repetition: {
      kind: 'until', maxIterations: 2, stopWhen: { kind: 'exists', value: { kind: 'session_context_field', field: 'usage.tokensUsed' } },
    } }]);
    const execute: WorkflowStepExecutor = async (params) => { await params.beforeInputAdmission(); return { kind: 'completed', result: 'worked' }; };
    await expect(createWorkflowCoordinator({ ...deps(store, execute), sessionContext: { resolveSessionContextField: async () => 0 } })
      .run({ ...run(definition), originSessionId: 'origin' })).resolves.toEqual({ state: 'succeeded' });
    expect(closingOutcome(store)).toMatchObject({ outcome: { kind: 'stop_condition' } });
    const restarted = createInMemoryWorkflowCoordinatorStore();
    for (const [key, row] of store.records) restarted.records.set(key, row);
    await expect(createWorkflowCoordinator({ ...deps(restarted, async () => { throw new Error('replayed effect'); }), sessionContext: {
      resolveSessionContextField: async () => { throw new Error('reevaluated stop'); },
    } }).run({ ...run(definition), originSessionId: 'origin' })).resolves.toEqual({ state: 'succeeded' });
  });
});
