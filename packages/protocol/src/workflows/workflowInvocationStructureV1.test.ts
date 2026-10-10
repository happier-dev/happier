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

describe('frozen invocation structure owner', () => {
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

  it('keeps the child root distinct from a nearer inherited parallel conversation owner', async () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'workflow', id: 'nested', workflowRef: 'builtin:child', input: {} },
    ] });
    const child = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'parallel', id: 'fanout', maxConcurrent: 1, failurePolicy: 'fail_stop', branches: [
        { id: 'branch', blocks: [{ kind: 'step', id: 'work', document, result: { kind: 'text' } }] },
      ] },
    ] });
    await expect(resolve(definition, [row(0, null, '0', 'root', '$root'), row(1, 0, '0', 'workflow', 'nested'),
      row(2, 1, '0', 'parallel', 'fanout'),
      row(3, 2, '0', 'parallel', 'fanout', { frame: { ownerBlockId: 'fanout', source: { kind: 'branch', branchId: 'branch' } } }),
      row(4, 3, '0', 'step', 'work')], { 'builtin:child': child })).resolves.toMatchObject({
      sourceKey: 'builtin:child', rootConversationOwnerRecordId: ids[1], inheritedConversationOwnerRecordId: ids[3],
    });
  });
});
