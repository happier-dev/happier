import { createTestWorkflowCoordinator as createWorkflowCoordinator } from './workflowCoordinator.testkit';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as workflowStoredContent from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
  openWorkflowCheckpointStoredEnvelopeV1,
  materializeWorkflowAcceptedSnapshotV1,
  parseWorkflowStoredContentEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowBlock,
  type WorkflowCheckpointEnvelopeV1,
  type WorkflowDefinitionV1,
  type WorkflowStep,
} from '@happier-dev/protocol/workflows';
import {  workflowInvocationKey, type WorkflowCoordinatorInvocation } from './coordinator';
import { DurableWorkflowCoordinatorStore } from './production';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const accountId = 'account-1';
const rootId = 'frontier-root';
const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' as const } };
const authorization = { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const };
const workspace = { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' };
const step = (id: string, input: WorkflowStep['input'] = []): WorkflowStep => ({ kind: 'step', id,
  document: { text: id, references: [], attachments: [] }, input, result: { kind: 'text' } });

async function fixture(blocks: readonly WorkflowBlock[], options: Readonly<{ projectProgress?: boolean }> = {}) {
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
  }, blocks: [...blocks] };
  let acceptedEnvelope = '{}';
  if (options.projectProgress) {
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId: workspace.machineId,
        executionTarget: { kind: 'session' }, workspaceTarget: { project: workspace }, origin: { kind: 'direct' }, authorization },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!materialized.ok) throw new Error(`workflow_fixture_not_materialized:${materialized.error.code}`);
    acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: materialized.snapshot }));
  }
  const boundary = createWorkflowRunStorageTestkit({ runId, machineId: workspace.machineId,
    origin: { kind: 'direct' }, invocationPageSize: 31, acceptedEnvelope });
  const checkpoint: WorkflowCheckpointEnvelopeV1 = { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
    nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
  const serializedCheckpoint = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint,
  }));
  await boundary.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: serializedCheckpoint,
    rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId },
    })) } });
  const kinds = new Map<string, WorkflowBlock['kind']>();
  const visit = (blocks: readonly WorkflowBlock[]) => { for (const block of blocks) {
    kinds.set(block.id, block.kind);
    if (block.kind === 'if') { visit(block.then); visit(block.otherwise); }
    if (block.kind === 'parallel') for (const branch of block.branches) visit(branch.blocks);
    if (block.kind === 'loop') { visit(block.body); if (block.repetition.kind === 'evaluate') kinds.set(block.repetition.evaluator.id, 'step'); }
  } };
  visit(blocks);
  const load = async (storage: ConstructorParameters<typeof DurableWorkflowCoordinatorStore>[0]['storage'] = boundary) => {
    const opened = openWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(boundary.checkpointEnvelope()),
    });
    if (opened.kind !== 'available') throw new Error('checkpoint_unavailable');
    return await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, storage, encryption,
      rootRecordId: rootId, revision: boundary.run().revision, checkpoint: opened.content,
      ...(options.projectProgress ? { authoredDefinition: definition, definition } : {}) });
  };
  const seed = await load();
  let row = 0;
  const intent = async (blockId: string, ordinal: number, fields: Partial<WorkflowCoordinatorInvocation> = {}) => {
    const scope = fields.path?.scope ?? [];
    const blockKind = fields.blockKind ?? kinds.get(blockId);
    if (!blockKind) throw new Error('fixture_block_kind_missing');
    const record = { key: workflowInvocationKey({ runId, blockId, scope, attempt: 0 }), recordId: `frontier-row-${row++}`,
      runId, blockId, memberOrdinal: String(ordinal), path: { blockId, scope }, attempt: 0,
      acceptedAtMs: Date.now(), lifecycle: 'completed' as const, ...fields };
    await seed.ensureIntent({ ...record, blockKind, lifecycle: 'pending' });
    return await seed.commitFact({ key: record.key, lifecycle: record.lifecycle,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.containerResult ? { containerResult: { kind: 'container', containerRecordId: record.recordId } } : {}),
    });
  };
  const run = async (store: DurableWorkflowCoordinatorStore, def = definition,
    effect?: Parameters<typeof createWorkflowCoordinator>[0]['executeStep'],
    composition: Pick<Parameters<ReturnType<typeof createWorkflowCoordinator>['run']>[0], 'frozenChildren' | 'materializedLeaves'> = {},
    sessionContext?: Parameters<typeof createWorkflowCoordinator>[0]['sessionContext']) => {
    const effects: string[] = [];
    const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId, sessionContext,
      resolveWorkspace: async () => ({ ok: true, workspace }),
      executeStep: effect ?? (async ({ step, beforeInputAdmission }) => {
        await beforeInputAdmission(); effects.push(step.id); return { kind: 'completed', result: step.id };
      }),
    });
    return { result: await coordinator.run({ runId, definition: def, inputs: {}, executionTarget: { kind: 'session' }, authorization, ...composition }), effects };
  };
  return { boundary, seed, load, intent, definition, run };
}

describe('recorded durable workflow frontier', () => {
  it.each(['pending', 'cancel_requested'] as const)('reads fresh root control from its one authoritative snapshot (%s)', async lifecycle => {
    const f = await fixture(Array.from({ length: 500 }, (_, index) => step(`control-${index}`)));
    const store = await f.load();
    const root = await f.seed.readByLogicalInvocation(rootId);
    expect(root).toBeDefined();
    if (lifecycle === 'cancel_requested') await f.seed.commitFact({ key: root!.key, lifecycle });
    const callsAt = f.boundary.calls.length;
    expect(await store.readControl()).toBe(lifecycle === 'cancel_requested' ? 'cancel_requested' : 'running');
    // get already contains the exact root row from this same authoritative
    // snapshot. Fetching it again adds a request at every effect admission.
    expect(f.boundary.calls.slice(callsAt).map(call => call.operation)).toEqual(['get']);
  });

  it.each(['omitted', 'wrong_row'] as const)('keeps root control authoritative when the snapshot projection is %s', async projection => {
    const f = await fixture([step('decoy')]);
    const leaf = await f.intent('decoy', 0);
    const store = await f.load({ execute: async (...args) => {
      const response = await f.boundary.execute(...args);
      return args[0].operation === 'get' && response && typeof response === 'object'
        ? { ...response, rootProgress: projection === 'omitted' ? undefined : f.boundary.rowById(leaf.recordId) }
        : response;
    } });
    const root = await f.seed.readByLogicalInvocation(rootId);
    await f.seed.commitFact({ key: root!.key, lifecycle: 'cancel_requested' });
    if (projection === 'wrong_row') await expect(store.readControl()).rejects.toThrow('workflow_storage_response_invalid');
    else await expect(store.readControl()).resolves.toBe('cancel_requested');
  });

  it('shares the admitted 500-member loop projection with recovery scheduling', async () => {
    const items = Array.from({ length: 500 }, (_, index) => index);
    const loop: WorkflowBlock = { kind: 'loop', id: 'projected-items', repetition: { kind: 'items',
      items: { kind: 'literal', value: items },
      execution: 'parallel', maxConcurrent: 2, failurePolicy: 'fail_stop' }, body: [step('work')] };
    const f = await fixture([loop], { projectProgress: true });
    const owner = await f.intent(loop.id, 0, { lifecycle: 'running', container: { kind: 'loop', mode: 'items',
      source: { kind: 'definition', reference: { kind: 'literal', value: items } },
      itemCount: '500', nextMemberIndex: '500', nextBodyBlockOrdinal: '0' } });
    for (let index = 0; index < 500; index++) await f.intent(loop.id, index, { parentKey: owner.key,
      path: { blockId: loop.id, scope: [{ kind: 'iteration', blockId: loop.id, index }] },
      frame: { ownerBlockId: loop.id, source: { kind: 'item', index: String(index) } },
      container: { kind: 'body', nextBlockOrdinal: '1' } });
    const callsAt = f.boundary.calls.length;
    const members = await f.seed.listCurrentMembers(owner.key);
    expect(members).toHaveLength(500);
    expect(members.every(row => row.lifecycle === 'completed')).toBe(true);
    expect(await f.seed.listCurrentMembers(owner.key)).toEqual(members);
    // The executing owner has already acquired and maintained these exact
    // member indices for loop progress. A second consumer must reuse them.
    expect(f.boundary.calls.slice(callsAt)).toEqual([]);
  });

  it('reserves distinct child root shared gates when two frozen child uses retain native input', async () => {
    const nested: WorkflowBlock = { kind: 'workflow', id: 'nested-native', workflowRef: 'builtin:child', input: {} };
    const siblings = [{ ...nested, id: 'left-child' }, { ...nested, id: 'right-child' }];
    const f = await fixture([{ kind: 'parallel', id: 'parent', failurePolicy: 'fail_stop', branches: siblings.map(leaf => ({
      id: leaf.id, blocks: [leaf],
    })) }]);
    const conversation = { kind: 'shared_run' as const };
    const child: WorkflowDefinitionV1 = { ...f.definition, blocks: [{ ...step('owned-native'), execution: { conversation } }] };
    const parallel = await f.intent('parent', 0, { blockKind: 'parallel', lifecycle: 'running',
      container: { kind: 'parallel', nextBranchOrdinal: '2' } });
    for (const [ordinal, leaf] of siblings.entries()) {
      const branchScope = [{ kind: 'branch' as const, blockId: 'parent', branchId: leaf.id }];
      const body = await f.intent('parent', ordinal, { blockKind: 'parallel', parentKey: parallel.key,
        path: { blockId: 'parent', scope: branchScope }, lifecycle: 'running',
        frame: { ownerBlockId: 'parent', source: { kind: 'branch', branchId: leaf.id } },
        container: { kind: 'body', nextBlockOrdinal: '0' } });
      const frame = await f.intent(leaf.id, 0, { blockKind: 'workflow', parentKey: body.key,
        path: { blockId: leaf.id, scope: branchScope }, lifecycle: 'running',
        container: { kind: 'body', nextBlockOrdinal: '0', frameInputs: {}, frameProjectWorkspace: { descriptor: workspace } } });
      const childScope = [...branchScope, { kind: 'workflow' as const, blockId: leaf.id }];
      const owned = await f.intent('owned-native', 0, { blockKind: 'step', parentKey: frame.key,
        path: { blockId: 'owned-native', scope: childScope }, lifecycle: 'running',
        execution: { kind: 'detached_run', runId: leaf.id, localInputId: 'owned-input', runtimeSelection: {} },
        input: { document: step('owned-native').document, input: [] }, workspace: { descriptor: workspace } });
      await f.seed.commitSharedConversation({ scopeOwnerKey: frame.recordId, targetClass: 'detached_run', invocationRecordId: owned.recordId });
    }
    const observed: string[] = [];
    const result = await f.run(await f.load(), f.definition, async params => {
      if (params.invocation.execution?.kind !== 'detached_run') throw new Error('expected retained native input');
      observed.push(params.invocation.execution.runId);
      return { kind: 'completed', result: params.invocation.execution.runId };
    }, { frozenChildren: { 'builtin:child': child }, materializedLeaves: [
      ...siblings.map(leaf => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: leaf.id, kind: 'workflow' as const, selection: {},
        executionTarget: { kind: 'detached_run' as const }, childRef: 'builtin:child' })),
      { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: 'owned-native', kind: 'step', selection: { conversation }, executionTarget: { kind: 'detached_run' } },
    ] });
    expect(result).toMatchObject({ result: { state: 'succeeded' } });
    expect(observed.sort()).toEqual(['left-child', 'right-child']);
  });

  it('persists a loop and its iteration frame inside a frozen child without root block-kind lookup', async () => {
    const nested: WorkflowBlock = { kind: 'workflow', id: 'nested-loop', workflowRef: 'builtin:child', input: {} };
    const f = await fixture([nested]);
    const child: WorkflowDefinitionV1 = { ...f.definition, blocks: [{ kind: 'loop', id: 'child-loop',
      repetition: { kind: 'count', count: { kind: 'literal', value: 1 } }, body: [step('child-work')] }] };
    const observed = await f.run(await f.load(), f.definition, undefined, {
      frozenChildren: { 'builtin:child': child }, materializedLeaves: [
        { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: nested.id, kind: 'workflow', selection: {}, executionTarget: { kind: 'session' }, childRef: 'builtin:child' },
        { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: 'child-work', kind: 'step', selection: child.defaults, executionTarget: { kind: 'session' } },
      ],
    });
    expect(observed).toMatchObject({ effects: ['child-work'], result: { state: 'succeeded' } });
    const restored = await f.load();
    const rows = await Promise.all(f.boundary.rows().map(row => restored.readByLogicalInvocation(row.index.id)));
    expect(rows.filter(row => row?.blockId === 'child-loop').map(row => row?.blockKind)).toEqual(['loop', 'loop']);
    expect(await f.run(restored, f.definition, undefined, {
      frozenChildren: { 'builtin:child': child }, materializedLeaves: [
        { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: nested.id, kind: 'workflow', selection: {}, executionTarget: { kind: 'session' }, childRef: 'builtin:child' },
        { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: 'child-work', kind: 'step', selection: child.defaults, executionTarget: { kind: 'session' } },
      ],
    })).toMatchObject({ effects: [], result: { state: 'succeeded' } });
  });

  it('executes repeated inline Workflow frames beneath a capacity-one parent without another Run', async () => {
    const nested: WorkflowBlock = { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} };
    const second: WorkflowBlock = { ...nested, id: 'nested-again' };
    const parent: WorkflowBlock = { kind: 'parallel', id: 'capacity-one', maxConcurrent: 1,
      failurePolicy: 'fail_stop', branches: [
        { id: 'first', blocks: [nested] }, { id: 'second', blocks: [second] },
      ] };
    const f = await fixture([parent]);
    const child: WorkflowDefinitionV1 = { ...f.definition, blocks: [step('child-work')] };
    const observed = await f.run(await f.load(), f.definition, undefined, {
      frozenChildren: { 'builtin:child': child }, materializedLeaves: [
        ...[nested, second].map((leaf) => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: leaf.id, kind: 'workflow' as const,
          selection: {}, executionTarget: { kind: 'session' as const }, childRef: 'builtin:child' })),
        { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: 'child-work', kind: 'step', selection: child.defaults,
          executionTarget: { kind: 'session' } },
      ],
    });
    expect(observed).toMatchObject({ effects: ['child-work', 'child-work'], result: { state: 'succeeded' } });
    expect(f.boundary.rows().filter((row) => row.index.parentRecordId === null)).toHaveLength(1);
    expect(new Set(f.boundary.rows().map((row) => row.index.runId))).toEqual(new Set([runId]));
    expect(f.boundary.operations()).not.toContain('start');
  });

  it.each(['input', 'origin'] as const)('selects a completed inline Workflow output from its persisted lexical inputs or origin (%s) after restart', async (output) => {
    const nested: WorkflowBlock = { kind: 'workflow', id: 'nested-input', workflowRef: 'builtin:child',
      input: { request: { kind: 'literal', value: 'child-private' } } };
    const f = await fixture([nested]);
    const child: WorkflowDefinitionV1 = { ...f.definition,
      inputs: [{ name: 'request', valueType: 'string', required: true }], blocks: [{ ...step('child-work', [
        output === 'input' ? { kind: 'input', name: 'request' } : { kind: 'session_context_field', field: 'usage.tokensUsed' },
      ]), result: output === 'input' ? { kind: 'text' } : { kind: 'json', schema: { type: 'number' } } }],
      finalOutput: { kind: 'result', producer: { blockId: 'child-work', scope: { kind: 'current' } }, path: [] } };
    const sessionContext = { resolveSessionContextField: async () => 17 };
    const composition = { frozenChildren: { 'builtin:child': child }, materializedLeaves: [
      { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: nested.id, kind: 'workflow' as const, selection: {},
        executionTarget: { kind: 'session' as const }, childRef: 'builtin:child' },
      { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: 'child-work', kind: 'step' as const,
        selection: child.defaults, executionTarget: { kind: 'session' as const } },
    ] };
    const executed: string[] = [];
    expect(await f.run(await f.load(), f.definition, async ({ step: leaf, input, beforeInputAdmission }) => {
      await beforeInputAdmission();
      executed.push(leaf.id);
      const result = input.values[0];
      if (result === undefined) throw new Error('missing_bound_child_input');
      return { kind: 'completed', result: leaf.result.kind === 'json' ? JSON.stringify(result) : result,
        resultEncoding: 'raw_text' };
    }, composition, sessionContext)).toMatchObject({ result: { state: 'succeeded' } });
    expect(executed).toEqual(['child-work']);
    const selected = { ...f.definition, finalOutput: { kind: 'result' as const,
      producer: { blockId: nested.id, scope: { kind: 'current' as const } }, path: [] } };
    expect(await f.run(await f.load(), selected, undefined, composition, sessionContext))
      .toMatchObject({ effects: [], result: { state: 'succeeded', finalOutput: output === 'input' ? 'child-private' : 17 } });
  });

  it('resumes an inline Workflow frame from its body cursor and selects its final producer', async () => {
    const nested: WorkflowBlock = { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} };
    const f = await fixture([nested]);
    const child: WorkflowDefinitionV1 = { ...f.definition, blocks: [step('child-done'), step('child-next')], finalOutput: {
      kind: 'result', producer: { blockId: 'child-done', scope: { kind: 'current' } }, path: [] } };
    const row = await f.intent('nested', 0, { lifecycle: 'running', container: { kind: 'body', nextBlockOrdinal: '1' },
      workspace: { descriptor: workspace } });
    const scope = [{ kind: 'workflow' as const, blockId: 'nested' }];
    const done = await f.intent('child-done', 0, { blockKind: 'step', parentKey: row.key,
      path: { blockId: 'child-done', scope }, result: 'selected-child' });
    const loaded = await f.load();
    const callsAt = f.boundary.calls.length;
    const result = await f.run(loaded, { ...f.definition, finalOutput: { kind: 'result',
      producer: { blockId: 'nested', scope: { kind: 'current' } }, path: [] } }, undefined, {
      frozenChildren: { 'builtin:child': child }, materializedLeaves: [
        { authoredWorkspace: { kind: 'inherit' as const }, sourceKey: '$root', blockId: 'nested', kind: 'workflow', selection: {}, executionTarget: { kind: 'session' }, childRef: 'builtin:child' },
        ...child.blocks.map((block) => ({ authoredWorkspace: { kind: 'inherit' as const }, sourceKey: 'builtin:child', blockId: block.id, kind: 'step' as const,
          selection: child.defaults, executionTarget: { kind: 'session' as const } })),
      ],
    });
    expect(result).toMatchObject({ effects: ['child-next'], result: { state: 'succeeded', finalOutput: 'selected-child' } });
    // The completed child is a declared final dependency, not a replayed leaf.
    expect(f.boundary.calls.slice(callsAt).filter((call) => call.operation === 'invocations.current'
      && call.parentRecordId === row.recordId && call.memberOrdinal === '0')).toHaveLength(1);
    expect(f.boundary.rows().find((item) => item.index.id === done.recordId)?.index.contentRevision).toBe('1');
  });

  it('measures four successive hold wakes without reopening an unrelated completed prefix', async () => {
    const prefix = Array.from({ length: 500 }, (_, index) => step(`wake-prefix-${index}`));
    const loop: WorkflowBlock = { kind: 'loop', id: 'held-items', repetition: { kind: 'items',
      items: { kind: 'literal', value: [0, 1, 2, 3] }, execution: 'parallel', maxConcurrent: 2, failurePolicy: 'fail_stop' },
      body: [{ kind: 'wait', id: 'person', document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }] };
    const f = await fixture([...prefix, loop]);
    for (let index = 0; index < prefix.length; index++) await f.intent(prefix[index]!.id, index, { result: 'x'.repeat(8192) });
    await f.seed.commitFrontier({ nextBlockOrdinal: prefix.length });
    const measurements: Array<Record<string, number>> = [];
    let held = await f.run(await f.load());
    expect(held.result.state).toBe('waiting_for_review');
    for (let wake = 0; wake < 4; wake++) {
      await f.boundary.execute({ operation: 'transition', runId, expectedRevision: held.result.parkRevision,
        state: 'waiting_for_review', checkpointEnvelope: f.boundary.checkpointEnvelope() });
      const humanStore = await f.load();
      const row = f.boundary.rows().find((row) => row.index.lifecycle === 'waiting_for_review');
      expect(row).toBeDefined();
      const invocation = await humanStore.readByLogicalInvocation(row!.index.id);
      await humanStore.commitFact({ key: invocation!.key, lifecycle: 'completed', result: `accepted-${wake}` });
      await f.boundary.execute({ operation: 'resume', runId, expectedRevision: f.boundary.run().revision });
      const metrics = { requests: 0, openedEnvelopes: 0, openedBytes: 0, materializedResultBytes: 0, peakHeapBytes: 0 };
      const openedIds: string[] = [];
      const storage = { execute: async (...args: Parameters<typeof f.boundary.execute>) => {
        metrics.requests++;
        const response = await f.boundary.execute(...args);
        if (response && typeof response === 'object' && 'invocation' in response && response.invocation
          && typeof response.invocation === 'object' && 'contentEnvelope' in response.invocation
          && typeof response.invocation.contentEnvelope === 'string') {
          metrics.openedEnvelopes++; metrics.openedBytes += Buffer.byteLength(response.invocation.contentEnvelope);
          if ('index' in response.invocation && response.invocation.index && typeof response.invocation.index === 'object'
            && 'id' in response.invocation.index) openedIds.push(String(response.invocation.index.id));
        }
        metrics.peakHeapBytes = Math.max(metrics.peakHeapBytes, process.memoryUsage().heapUsed);
        return response;
      } };
      const started = performance.now();
      const store = await f.load(storage);
      const returned = new Map<string, number>();
      const measuredStore = new Proxy(store, { get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || !['read', 'readCurrent', 'readByLogicalInvocation', 'readContainerResult'].includes(String(property))) return value;
        return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(value, target, args);
          if (property === 'readContainerResult' && result !== undefined) returned.set(`container:${String((args[0] as WorkflowCoordinatorInvocation).recordId)}`, Buffer.byteLength(JSON.stringify(result)));
          else if (result && typeof result === 'object' && 'recordId' in result && 'result' in result && result.result !== undefined)
            returned.set(String(result.recordId), Buffer.byteLength(JSON.stringify(result.result)));
          return result;
        };
      } });
      held = await f.run(measuredStore);
      measurements.push({ ...metrics, materializedResultBytes: [...returned.values()].reduce((sum, bytes) => sum + bytes, 0),
        elapsedMs: performance.now() - started, peakRssKiB: process.resourceUsage().maxRSS });
      expect(held.effects).toEqual([]);
      expect(held.result.state).toBe(wake === 3 ? 'succeeded' : 'waiting_for_review');
      // Accumulate all measurements before the deliberate baseline falsifier.
      if (wake === 3) {
        process.stdout.write(`FIN_E4_HOLD_METRICS=${JSON.stringify({ fixture: '500x8192-byte completed prefix; four item holds resolved one at a time; authored concurrency 2', measurements })}\n`);
        expect(openedIds).not.toContain(f.boundary.rows().find((row) => row.index.parentRecordId === rootId && row.index.memberOrdinal === '0')!.index.id);
      }
    }
  });

  it('bounds reads across admission and one-at-a-time parked item hold restarts', async () => {
    const fullMeasurement = process.env.HAPPIER_WORKFLOW_SCALE_MEASUREMENT === '1';
    const itemCount = fullMeasurement ? 500 : 12;
    const loop: WorkflowBlock = { kind: 'loop', id: 'parked-items', repetition: { kind: 'items',
      items: { kind: 'literal', value: Array.from({ length: itemCount }, (_, index) => index) },
      execution: 'parallel', maxConcurrent: 2, failurePolicy: 'fail_stop' },
      body: [{ kind: 'wait', id: 'person', document: { text: 'Continue', references: [], attachments: [] }, result: { kind: 'text' } }] };
    const f = await fixture([loop], { projectProgress: true });
    const measure = () => {
      const metrics = { requests: 0, acquiredEnvelopes: 0, acquiredEnvelopeBytes: 0, openedEnvelopes: 0, openedEnvelopeBytes: 0, responseBytes: 0,
        byOperation: {} as Record<string, number> };
      return { metrics, storage: { execute: async (...args: Parameters<typeof f.boundary.execute>) => {
        const operation = String(args[0].operation);
        metrics.requests++;
        metrics.byOperation[operation] = (metrics.byOperation[operation] ?? 0) + 1;
        const response = await f.boundary.execute(...args);
        metrics.responseBytes += Buffer.byteLength(JSON.stringify(response));
        if (response && typeof response === 'object' && 'invocation' in response && response.invocation
          && typeof response.invocation === 'object' && 'contentEnvelope' in response.invocation
          && typeof response.invocation.contentEnvelope === 'string') {
          metrics.acquiredEnvelopes++;
          metrics.acquiredEnvelopeBytes += Buffer.byteLength(response.invocation.contentEnvelope);
        }
        return response;
      } } };
    };
    let activeMetrics: ReturnType<typeof measure>['metrics'] | undefined;
    const originalOpen = workflowStoredContent.openWorkflowProgressStoredEnvelopeV1;
    // Observe the real codec without substituting any validation or opening
    // behavior. Snapshot-embedded roots open without a detail acquisition.
    const openObserver = vi.spyOn(workflowStoredContent, 'openWorkflowProgressStoredEnvelopeV1').mockImplementation(params => {
      if (activeMetrics) {
        activeMetrics.openedEnvelopes++;
        activeMetrics.openedEnvelopeBytes += Buffer.byteLength(JSON.stringify(params.envelope));
      }
      return originalOpen(params);
    });
    onTestFinished(() => openObserver.mockRestore());
    const admission = measure();
    activeMetrics = admission.metrics;
    let held = await f.run(await f.load(admission.storage));
    expect(held.result.state).toBe('waiting_for_review');
    expect(f.boundary.rows().filter(row => row.index.lifecycle === 'waiting_for_review')).toHaveLength(2);
    const wakes: Array<Readonly<{ resolution: ReturnType<typeof measure>['metrics']; restart: ReturnType<typeof measure>['metrics'] }>> = [];
    // The default count contract completes every cycle at small scale. The
    // HAPPIER_WORKFLOW_SCALE_MEASUREMENT=1 exercises the same journey at 500
    // through the default source-test config (with --testTimeout=0).
    const wakeCount = itemCount;
    for (let wake = 0; wake < wakeCount; wake++) {
      await f.boundary.execute({ operation: 'transition', runId, expectedRevision: held.result.parkRevision,
        state: 'waiting_for_review', checkpointEnvelope: f.boundary.checkpointEnvelope() });
      const resolution = measure();
      activeMetrics = resolution.metrics;
      const humanStore = await f.load(resolution.storage);
      const row = f.boundary.rows().find(row => row.index.lifecycle === 'waiting_for_review');
      expect(row).toBeDefined();
      const invocation = await humanStore.readByLogicalInvocation(row!.index.id);
      await humanStore.commitFact({ key: invocation!.key, lifecycle: 'completed', result: `accepted-${wake}` });
      await f.boundary.execute({ operation: 'resume', runId, expectedRevision: f.boundary.run().revision });
      const restart = measure();
      activeMetrics = restart.metrics;
      const restartCallsAt = f.boundary.calls.length;
      held = await f.run(await f.load(restart.storage));
      wakes.push({ resolution: resolution.metrics, restart: restart.metrics });
      expect(held.result.state).toBe(wake === itemCount - 1 ? 'succeeded' : 'waiting_for_review');
      expect(held.effects).toEqual([]);
      const parentPages = f.boundary.calls.slice(restartCallsAt).filter(call => call.operation === 'invocations.list'
        && call.parentRecordId !== undefined && call.lifecycles === undefined).map(call => JSON.stringify(call));
      expect(new Set(parentPages).size).toBe(parentPages.length);
      expect(resolution.metrics.requests).toBe(5);
      expect(resolution.metrics.openedEnvelopes).toBe(4);
      expect(f.boundary.rows().filter(row => row.index.lifecycle === 'waiting_for_review')).toHaveLength(Math.min(2, itemCount - wake - 1));
    }
    await new Promise<void>(resolve => process.stdout.write(
      `FIN_PARKED_500_METRICS=${JSON.stringify({ itemCount, admission: admission.metrics, wakes })}\n`, () => resolve()));
  });

  it.each(['latest', 'all'] as const)('loads selected %s evaluator history without replaying completed bodies', async (history) => {
    const evaluator: WorkflowStep = { ...step('judge'), result: { kind: 'decision', decisions: ['continue', 'stop'] } };
    const loop: WorkflowBlock = { kind: 'loop', id: 'rounds', repetition: { kind: 'evaluate', evaluator, history, maxIterations: 3 },
      body: [step('work', [{ kind: 'result', producer: { blockId: 'work',
        scope: { kind: 'previous_iteration', loopBlockId: 'rounds' } }, path: [], optional: true }])] };
    const f = await fixture([loop]);
    const owner = await f.intent('rounds', 0, { lifecycle: 'running', container: { kind: 'loop', mode: 'evaluate',
      nextMemberIndex: '2', nextBodyBlockOrdinal: '0' } });
    const completedBodyIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const scope = [{ kind: 'iteration' as const, blockId: 'rounds', index }];
      const body = await f.intent('rounds', index, { parentKey: owner.key, path: { blockId: 'rounds', scope },
        frame: { ownerBlockId: 'rounds', source: { kind: 'iteration', index: String(index) } },
        container: { kind: 'body', nextBlockOrdinal: '1' }, containerResult: { kind: 'container', containerRecordId: `body-${index}` } });
      completedBodyIds.push(body.recordId);
      await f.intent('work', 0, { parentKey: body.key, path: { blockId: 'work', scope }, result: `work-${index}` });
      await f.intent('judge', 1, { parentKey: body.key, path: { blockId: 'judge', scope }, result: 'continue' });
    }
    const effects: string[] = [];
    const seenInputs: unknown[] = [];
    const readsAt = f.boundary.calls.length;
    const observed = await f.run(await f.load(), f.definition, async (params) => {
      await params.beforeInputAdmission(); effects.push(params.step.id); seenInputs.push(params.input.values);
      return { kind: 'completed', result: params.step.id === 'judge' ? 'stop' : 'work-2', resultEncoding: 'typed' };
    });
    expect(observed.result).toMatchObject({ state: 'succeeded' });
    expect(effects).toEqual(['work', 'judge']);
    expect(seenInputs).toEqual([['work-1'], [{ kind: 'evaluation_history', evaluations: history === 'latest' ? ['continue'] : ['continue', 'continue'] }]]);
    // Previous/latest select body 1. Only explicit all history needs body 0.
    const historicalChildren = f.boundary.calls.slice(readsAt).filter((call) => call.operation === 'invocations.current'
      && call.parentRecordId === completedBodyIds[0]);
    if (history === 'latest') expect(historicalChildren).toHaveLength(0);
  });

  it.each([1, undefined])('retains slower earlier item pipelines and duplicate positions with cap %s', async (maxConcurrent) => {
    const loop: WorkflowBlock = { kind: 'loop', id: 'items', repetition: { kind: 'items',
      items: { kind: 'literal', value: ['duplicate', 'duplicate', 'last'] }, execution: 'parallel', failurePolicy: 'fail_stop',
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    }, body: [step('first'), step('second')] };
    const f = await fixture([loop]);
    const owner = await f.intent('items', 0, { lifecycle: 'running', container: { kind: 'loop', mode: 'items',
      source: { kind: 'definition', reference: { kind: 'literal', value: ['duplicate', 'duplicate', 'last'] } },
      itemCount: '3', nextMemberIndex: '2', nextBodyBlockOrdinal: '0' } });
    const scope = (index: number) => [{ kind: 'iteration' as const, blockId: 'items', index }];
    const slow = await f.intent('items', 0, { parentKey: owner.key, path: { blockId: 'items', scope: scope(0) },
      lifecycle: 'running', frame: { ownerBlockId: 'items', source: { kind: 'item', index: '0' } },
      container: { kind: 'body', nextBlockOrdinal: '1' } });
    await f.intent('first', 0, { parentKey: slow.key, path: { blockId: 'first', scope: scope(0) }, result: 'slow-first' });
    const finished = await f.intent('items', 1, { parentKey: owner.key, path: { blockId: 'items', scope: scope(1) },
      frame: { ownerBlockId: 'items', source: { kind: 'item', index: '1' } },
      container: { kind: 'body', nextBlockOrdinal: '2' }, containerResult: { kind: 'container', containerRecordId: 'frontier-row-3' } });
    await f.intent('first', 0, { parentKey: finished.key, path: { blockId: 'first', scope: scope(1) }, result: 'fast-first' });
    await f.intent('second', 1, { parentKey: finished.key, path: { blockId: 'second', scope: scope(1) }, result: 'fast-second' });
    const resumed = await f.load();
    const effects: string[] = [];
    let releaseSlow!: () => void;
    const slowBarrier = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let started!: () => void;
    const slowStarted = new Promise<void>((resolve) => { started = resolve; });
    let lastStarted!: () => void;
    const lastBarrier = new Promise<void>((resolve) => { lastStarted = resolve; });
    const openedAt = f.boundary.calls.length;
    const running = f.run(resumed, { ...f.definition, finalOutput: { kind: 'result',
      producer: { blockId: 'items', scope: { kind: 'current' } }, path: [] } }, async (params) => {
      await params.beforeInputAdmission();
      effects.push(`${params.item?.index}:${params.step.id}`);
      if (params.item?.index === 0) { started(); await slowBarrier; }
      else lastStarted();
      return { kind: 'completed', result: `${params.item?.value}:${params.step.id}` };
    });
    await slowStarted;
    try {
      if (maxConcurrent === undefined) await lastBarrier;
      else {
        // A dependency-boundary request yields after scheduling the next reached
        // waiter, without a timer or mock of the internal capacity owner.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(effects).toEqual(['0:second']);
        expect(f.boundary.rows().filter((row) => row.index.parentRecordId === owner.recordId && row.index.lifecycle === 'waiting_for_capacity'))
          .toHaveLength(1);
      }
      // Before an explicit collection export, completed item 1 stays unopened.
      expect(f.boundary.calls.slice(openedAt).filter((call) => call.operation === 'invocations.get')
        .map((call) => call.invocationId)).not.toContain(finished.recordId);
    } finally { releaseSlow(); }
    const outcome = await running;
    expect(outcome.result).toMatchObject({ state: 'succeeded', finalOutput: [
      { index: 0, status: 'completed', results: { first: 'slow-first', second: 'duplicate:second' } },
      { index: 1, status: 'completed', results: { first: 'fast-first', second: 'fast-second' } },
      { index: 2, status: 'completed', results: { first: 'last:first', second: 'last:second' } },
    ] });
    expect(effects.sort()).toEqual(['0:second', '2:first', '2:second']);
  });

  it('reconciles a completed evaluator body whose parent cursor was not committed', async () => {
    const loop: WorkflowBlock = { kind: 'loop', id: 'rounds', repetition: { kind: 'evaluate', history: 'none', maxIterations: 2,
      evaluator: { ...step('judge'), result: { kind: 'decision', decisions: ['continue', 'stop'] } } }, body: [step('work')] };
    const f = await fixture([loop]);
    const owner = await f.intent('rounds', 0, { lifecycle: 'running', container: { kind: 'loop', mode: 'evaluate',
      nextMemberIndex: '0', nextBodyBlockOrdinal: '0' } });
    const scope = [{ kind: 'iteration' as const, blockId: 'rounds', index: 0 }];
    const body = await f.intent('rounds', 0, { parentKey: owner.key, path: { blockId: 'rounds', scope },
      frame: { ownerBlockId: 'rounds', source: { kind: 'iteration', index: '0' } },
      container: { kind: 'body', nextBlockOrdinal: '1' }, containerResult: { kind: 'container', containerRecordId: 'unused' } });
    await f.intent('work', 0, { parentKey: body.key, path: { blockId: 'work', scope }, result: 'done' });
    await f.intent('judge', 1, { parentKey: body.key, path: { blockId: 'judge', scope }, result: 'stop' });
    const observed = await f.run(await f.load());
    expect(observed).toMatchObject({ effects: [], result: { state: 'succeeded' } });
  });

  it('drains an occupying item input during a reclaimed pause without allocating its next capacity waiter', async () => {
    const loop: WorkflowBlock = { kind: 'loop', id: 'items', repetition: { kind: 'items', items: { kind: 'literal', value: [0, 1] },
      execution: 'parallel', maxConcurrent: 1, failurePolicy: 'fail_stop' }, body: [step('work')] };
    const f = await fixture([loop]);
    const owner = await f.intent('items', 0, { lifecycle: 'running', container: { kind: 'loop', mode: 'items',
      source: { kind: 'definition', reference: { kind: 'literal', value: [0, 1] } }, itemCount: '2', nextMemberIndex: '1', nextBodyBlockOrdinal: '0' } });
    const scope = [{ kind: 'iteration' as const, blockId: 'items', index: 0 }];
    const body = await f.intent('items', 0, { parentKey: owner.key, path: { blockId: 'items', scope }, lifecycle: 'running',
      frame: { ownerBlockId: 'items', source: { kind: 'item', index: '0' } }, container: { kind: 'body', nextBlockOrdinal: '0' } });
    await f.intent('work', 0, { parentKey: body.key, path: { blockId: 'work', scope }, lifecycle: 'running',
      workspace: { descriptor: workspace }, execution: { kind: 'session', sessionId: 'owned-session', localInputId: 'owned-input' } });
    await f.boundary.execute({ operation: 'pause', runId, expectedRevision: f.boundary.run().revision });
    const observations: string[] = [];
    const observed = await f.run(await f.load(), f.definition, async (params) => {
      expect(params.invocation.execution).toMatchObject({ kind: 'session', localInputId: 'owned-input' });
      observations.push(params.step.id);
      return { kind: 'completed', result: 'drained' };
    });
    expect(observed.result.state).toBe('paused');
    expect(observations).toEqual(['work']);
    expect(f.boundary.rows().filter((row) => row.index.parentRecordId === owner.recordId && row.index.memberOrdinal === '1')).toHaveLength(0);
  });

  it('opens only selected history and the active If ancestry after a long completed prefix', async () => {
    const prefix = Array.from({ length: 160 }, (_, index) => step(`prefix-${index}`));
    const done: WorkflowBlock = { kind: 'if', id: 'unselected-container',
      when: { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true }, right: { kind: 'literal', value: true } },
      then: [step('unselected-child')], otherwise: [] };
    const active: WorkflowBlock = { ...done, id: 'active-container', then: [step('active-done'), step('active-next', [
      { kind: 'result', producer: { blockId: 'prefix-7', scope: { kind: 'outer', levels: 1 } }, path: [] },
    ])] };
    const f = await fixture([...prefix, done, active]);
    const definition: WorkflowDefinitionV1 = { ...f.definition,
      finalOutput: { kind: 'result', producer: { blockId: 'prefix-7', scope: { kind: 'current' } }, path: [] } };
    for (let index = 0; index < prefix.length; index += 1) await f.intent(prefix[index]!.id, index, { result: 'x'.repeat(4096) });
    const unselected = await f.intent(done.id, 160, { container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' },
      containerResult: { kind: 'container', containerRecordId: 'frontier-row-160' } });
    await f.intent('unselected-child', 0, { parentKey: unselected.key, result: 'unselected' });
    const entered = await f.intent(active.id, 161, { lifecycle: 'running', container: { kind: 'if', selected: 'then', nextBlockOrdinal: '1' } });
    await f.intent('active-done', 0, { parentKey: entered.key, result: 'already done' });
    await f.seed.commitFrontier({ nextBlockOrdinal: 161 });

    const metrics = { requests: 0, openedEnvelopes: 0, openedBytes: 0, peakHeapBytes: 0, envelopeIds: [] as string[] };
    const measuredStorage = { execute: async (...args: Parameters<typeof f.boundary.execute>) => {
      metrics.requests += 1;
      const response = await f.boundary.execute(...args);
      if (response && typeof response === 'object' && 'invocation' in response) {
        const row = response.invocation;
        if (row && typeof row === 'object' && 'contentEnvelope' in row && typeof row.contentEnvelope === 'string') {
          metrics.openedEnvelopes += 1; metrics.openedBytes += Buffer.byteLength(row.contentEnvelope);
          if ('index' in row && row.index && typeof row.index === 'object' && 'id' in row.index) metrics.envelopeIds.push(String(row.index.id));
        }
      }
      metrics.peakHeapBytes = Math.max(metrics.peakHeapBytes, process.memoryUsage().heapUsed);
      return response;
    } };
    const before = performance.now();
    const resumed = await f.load(measuredStorage);
    const materialized = new Map<string, number>();
    // Instrument returned real store values; no domain implementation is mocked.
    const measuredStore = new Proxy(resumed, { get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || !['read', 'readCurrent', 'readByLogicalInvocation', 'readContainerResult'].includes(String(property))) return value;
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(value, target, args);
        if (property === 'readContainerResult' && result !== undefined) materialized.set(`container:${String((args[0] as WorkflowCoordinatorInvocation).recordId)}`, Buffer.byteLength(JSON.stringify(result)));
        else if (result && typeof result === 'object' && 'recordId' in result && 'result' in result && result.result !== undefined) {
          materialized.set(String(result.recordId), Buffer.byteLength(JSON.stringify(result.result)));
        }
        return result;
      };
    } });
    const observed = await f.run(measuredStore, definition);
    const elapsedMs = performance.now() - before;
    process.stdout.write(`FIN_E4_FRONTIER_METRICS=${JSON.stringify({ fixture: '160x4096-byte prefix + completed If + partial If; one selected prefix',
      ...metrics, materializedResultBytes: [...materialized.values()].reduce((sum, bytes) => sum + bytes, 0),
      elapsedMs, peakRssKiB: process.resourceUsage().maxRSS })}\n`);
    expect(observed.result).toMatchObject({ state: 'succeeded' });
    expect(observed.effects).toEqual(['active-next']);
    expect(observed.result.finalResult).toMatchObject({ result: { kind: 'text', value: 'x'.repeat(4096) },
      producerInvocation: { recordId: f.boundary.rows().find((row) => row.index.parentRecordId === rootId && row.index.memberOrdinal === '7')!.index.id } });
    expect(metrics.envelopeIds).not.toContain(unselected.recordId);
    expect(metrics.envelopeIds).not.toContain(f.boundary.rows().find((row) => row.index.parentRecordId === entered.recordId)?.index.id);
    expect(metrics.openedBytes).toBeLessThan(50_000);
  });
});
