import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from './workflowV1.js';
import { WorkflowProgressEnvelopeV1Schema, WorkflowRunInvocationIndexV1Schema } from './workflowProgressV1.js';
import { resolveWorkflowInvocationStructureV1, resolveWorkflowRetainedConversationAttemptV1, type WorkflowInvocationBindingRowV1 } from './workflowInvocationStructureV1.js';

const runId = '11111111-1111-4111-8111-111111111111';
const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666'];
const document = { text: 'Work', references: [], attachments: [] };
it('recovers an inputless Session from its real creation correspondence', async () => {
  const created = row(1, 0, '0', 'step', 'create', { execution: { kind: 'session_ready', sessionId: 'session-1' } });
  expect(await resolveWorkflowRetainedConversationAttemptV1({ invocation: created, readInvocation: async () => undefined })).toBe(created);
});
function row(position: number, parent: number | null, ordinal: string, blockKind: WorkflowInvocationBindingRowV1['progress']['blockKind'], blockId: string,
  fields: Partial<WorkflowInvocationBindingRowV1['progress']> = {}): WorkflowInvocationBindingRowV1 {
  return {
    index: WorkflowRunInvocationIndexV1Schema.parse({ id: ids[position], runId, parentRecordId: parent === null ? null : ids[parent],
      sequence: String(position), memberOrdinal: ordinal, attempt: '0', contentRevision: '0', lifecycle: 'running',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
    progress: WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind, invocationPath: { blockId, scope: [] },
      attempt: '0', logicalInvocationRecordId: ids[position], ...fields }),
  };
}
function resolve(definition: WorkflowDefinitionV1, rows: readonly WorkflowInvocationBindingRowV1[], frozenChildren?: Record<string, WorkflowDefinitionV1>) {
  return resolveWorkflowInvocationStructureV1({ definition, invocation: rows[rows.length - 1]!,
    readInvocation: async id => rows.find(candidate => candidate.index.id === id), keyOfInvocation: value => value.index.id,
    ...(frozenChildren ? { frozenChildren } : {}) });
}

it.each([false, true])('retains a recovered leaf across replaced parent frames (different logical slot: %s)', async differentSlot => {
  const prior = row(1, 0, '0', 'step', 'judge', {
    execution: { kind: 'detached_run', runId: 'native-judge', localInputId: 'old-input', runtimeSelection: {} },
  });
  prior.index.lifecycle = 'superseded';
  const replacement = row(3, 2, '0', 'step', 'judge', {
    attempt: '1', logicalInvocationRecordId: differentSlot ? ids[3] : prior.progress.logicalInvocationRecordId,
    previousAttemptRecordId: prior.index.id,
    recovery: { conversation: 'same_conversation', input: { kind: 'original' } },
  });
  replacement.index.attempt = '1';
  const result = await resolveWorkflowRetainedConversationAttemptV1({ invocation: replacement,
    readInvocation: async id => id === prior.index.id ? prior : undefined });
  if (differentSlot) expect(result).toBeUndefined();
  else expect(result).toBe(prior);
});

describe('frozen invocation structure owner', () => {
  it.each(['running', 'cancel_requested', 'cancelled', 'completed'] as const)(
    'checks ancestry eligibility without rejecting a completed loop source (%s)', async lifecycle => {
      const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], blocks: [
        { kind: 'step', id: 'select', document, result: { kind: 'json', schema: { type: 'array', items: { type: 'string' } } } },
        { kind: 'loop', id: 'panel', repetition: { kind: 'items',
          items: { kind: 'result', producer: { blockId: 'select', scope: { kind: 'current' } }, path: [] },
          execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [{ kind: 'step', id: 'answer', document }] },
      ] });
      const source = row(4, 0, '0', 'step', 'select', { result: ['first', 'second'] });
      source.index.lifecycle = 'completed';
      const loop = row(1, 0, '1', 'loop', 'panel', { container: {
        kind: 'loop', mode: 'items', nextMemberIndex: '0', nextBodyBlockOrdinal: '0',
        source: { kind: 'result', recordId: source.index.id, path: [] }, itemCount: '2',
      } });
      loop.index.lifecycle = lifecycle;
      const rows = [row(0, null, '0', 'root', '$root'), loop,
        row(2, 1, '1', 'loop', 'panel', { frame: { ownerBlockId: 'panel', source: { kind: 'item', index: '1' } } }),
        row(3, 2, '0', 'step', 'answer'), source];
      const result = await resolveWorkflowInvocationStructureV1({ definition, inputs: {}, invocation: rows[3]!,
        readInvocation: async id => rows.find(candidate => candidate.index.id === id), keyOfInvocation: value => value.index.id,
        isAncestryCurrent: candidate => candidate.index.lifecycle === 'running' });
      if (lifecycle === 'running') expect(result).toMatchObject({ frame: { item: { value: 'second', index: 1 } } });
      else expect(result).toBeUndefined();
    });

  it('recovers the exact item from the frozen loop source for accepted selection after restart', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'panel',
      repetition: { kind: 'items', items: { kind: 'literal', value: ['first', 'second'] }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ kind: 'step', id: 'answer', document }],
    }] });
    const rows = [row(0, null, '0', 'root', '$root'), row(1, 0, '0', 'loop', 'panel', { container: {
      kind: 'loop', mode: 'items', nextMemberIndex: '0', nextBodyBlockOrdinal: '0',
      source: { kind: 'definition', reference: { kind: 'literal', value: ['first', 'second'] } }, itemCount: '2',
    } }), row(2, 1, '1', 'loop', 'panel', { frame: { ownerBlockId: 'panel', source: { kind: 'item', index: '1' } } }), row(3, 2, '0', 'step', 'answer')];
    const result = await resolveWorkflowInvocationStructureV1({ definition, inputs: {}, invocation: rows[3]!,
      readInvocation: async id => rows.find(candidate => candidate.index.id === id), keyOfInvocation: value => value.index.id });
    expect(result).toMatchObject({ frame: { item: { value: 'second', index: 1, position: 2, count: 2 } } });
  });
  it('reopens the retained input field path instead of treating the entire input as the loop roster', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [{ name: 'panel', valueType: 'json', required: true }],
      blocks: [{ kind: 'loop', id: 'reviewers',
        repetition: { kind: 'items', items: { kind: 'input', name: 'panel', path: ['reviewers'] }, execution: 'parallel', failurePolicy: 'collect_outcomes' },
        body: [{ kind: 'step', id: 'answer', document }] }] });
    const rows = [row(0, null, '0', 'root', '$root'), row(1, 0, '0', 'loop', 'reviewers', { container: {
      kind: 'loop', mode: 'items', nextMemberIndex: '0', nextBodyBlockOrdinal: '0',
      source: { kind: 'definition', reference: { kind: 'input', name: 'panel', path: ['reviewers'] } }, itemCount: '2',
    } }), row(2, 1, '1', 'loop', 'reviewers', { frame: { ownerBlockId: 'reviewers', source: { kind: 'item', index: '1' } } }),
    row(3, 2, '0', 'step', 'answer')];
    await expect(resolveWorkflowInvocationStructureV1({ definition, inputs: { panel: { reviewers: ['first', 'second'] } },
      invocation: rows[3]!, readInvocation: async id => rows.find(candidate => candidate.index.id === id), keyOfInvocation: value => value.index.id }))
      .resolves.toMatchObject({ frame: { item: { value: 'second', index: 1, position: 2, count: 2 } } });
  });
  it.each(['action', 'wait'] as const)('resolves a %s leaf without a second block-id search', async kind => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      kind === 'action' ? { kind, id: 'leaf', actionId: 'notify_me', input: {}, pauseForReview: true }
        : { kind, id: 'leaf', document },
    ] });
    await expect(resolve(definition, [row(0, null, '0', 'root', '$root'), row(1, 0, '0', kind, 'leaf')]))
      .resolves.toMatchObject({ leaf: { kind, id: 'leaf' }, sourceKey: '$root' });
  });

  it('resolves the evaluator in its exact iteration frame', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'loop', id: 'repeat', body: [{ kind: 'step', id: 'body', document, result: { kind: 'text' } }],
        repetition: { kind: 'evaluate', maxIterations: 3, history: 'all',
          evaluator: { kind: 'step', id: 'verdict', document, result: { kind: 'decision', decisions: ['continue', 'stop'] } } } },
    ] });
    await expect(resolve(definition, [row(0, null, '0', 'root', '$root'), row(1, 0, '0', 'loop', 'repeat'),
      row(2, 1, '3', 'loop', 'repeat', { frame: { ownerBlockId: 'repeat', source: { kind: 'iteration', index: '3' } } }),
      row(3, 2, '1', 'step', 'verdict')])).resolves.toMatchObject({ leaf: { id: 'verdict', kind: 'step' },
        frame: { loop: { blockId: 'repeat', index: 3 } } });
  });

  it('crosses a Workflow frame only through its frozen child and resets lexical parentage', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} },
    ] });
    const child = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'step', id: 'answer', document, result: { kind: 'json', schema: { type: 'string', enum: ['child-value'] } }, pauseForReview: true },
    ] });
    const rows = [row(0, null, '0', 'root', '$root'), row(1, 0, '0', 'workflow', 'nested'), row(2, 1, '0', 'step', 'answer')];
    await expect(resolve(definition, rows, { 'builtin:child': child })).resolves.toMatchObject({
      leaf: { id: 'answer', result: { kind: 'json', schema: { enum: ['child-value'] } } }, sourceKey: 'builtin:child',
      inheritedConversationOwnerRecordId: ids[1], frame: { blocks: child.blocks, structuralKey: ids[1],
        scope: [{ kind: 'workflow', blockId: 'nested' }] },
    });
    expect((await resolve(definition, rows, { 'builtin:child': child }))?.rootConversationOwnerRecordId).toBe(ids[1]);
    expect((await resolve(definition, rows, { 'builtin:child': child }))?.frame.parent).toBeUndefined();
    await expect(resolve(definition, rows)).resolves.toBeUndefined();
  });

  it('refuses a same-named leaf whose ancestry slot does not match the frozen definition', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'leaf', document },
    ] });
    await expect(resolve(definition, [row(0, null, '0', 'root', '$root'), row(1, 0, '1', 'wait', 'leaf')])).resolves.toBeUndefined();
  });

  it.each([
    { kind: 'parallel', target: 2 }, { kind: 'parallel', target: 3 }, { kind: 'parallel', target: 4 },
    { kind: 'loop', target: 2 }, { kind: 'loop', target: 3 }, { kind: 'loop', target: 4 },
  ] as const)('keeps the child workspace root distinct from a nearer $kind conversation owner (target $target)', async ({ kind, target }) => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} },
    ] });
    const child = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      ...(kind === 'parallel' ? [{ kind: 'parallel', id: 'fanout', maxConcurrent: 1, failurePolicy: 'fail_stop', branches: [
        { id: 'branch', blocks: [{ kind: 'step', id: 'work', document, result: { kind: 'text' } }] },
      ] }] : [{ kind: 'loop', id: 'fanout', repetition: { kind: 'items', items: { kind: 'literal', value: ['first'] },
        execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [{ kind: 'step', id: 'work', document, result: { kind: 'text' } }] }]),
    ] });
    const rows = [row(0, null, '0', 'root', '$root'), row(1, 0, '0', 'workflow', 'nested'),
      row(2, 1, '0', kind, 'fanout'),
      row(3, 2, '0', kind, 'fanout', { frame: { ownerBlockId: 'fanout', source: kind === 'parallel'
        ? { kind: 'branch', branchId: 'branch' } : { kind: 'item', index: '0' } } }), row(4, 3, '0', 'step', 'work')];
    if (target !== 4) await expect(resolve(definition, rows.slice(0, target + 1), { 'builtin:child': child })).resolves.toBeUndefined();
    await expect(resolveWorkflowInvocationStructureV1({ definition, frozenChildren: { 'builtin:child': child },
      invocation: rows[target]!, readInvocation: async id => rows.find(candidate => candidate.index.id === id),
      keyOfInvocation: value => value.index.id, includeStructuralFrames: true })).resolves.toMatchObject({
      sourceKey: 'builtin:child', rootConversationOwnerRecordId: ids[1], inheritedConversationOwnerRecordId: target === 2 ? ids[1] : ids[3],
    });
  });
});
