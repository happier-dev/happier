import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';

import {
  applyWorkflowDefinitionEditsV1, createWorkflowBlock, createWorkflowLeafBlock, duplicateWorkflowBlock, insertWorkflowBlock, moveWorkflowBlock,
  removeWorkflowBlock, setWorkflowDefaultField, setWorkflowFinalOutput, setWorkflowInputs,
  setWorkflowStepExecutionField, setWorkflowStepText, setWorkflowStepTimeout, updateWorkflowBlock,
  setWorkflowBlockOnlyWhen, setWorkflowLeafPauseForReview, setWorkflowStepExecutionTarget,
  WorkflowDefinitionEditOpV1Schema, WorkflowInsertBlockV1Schema,
  type WorkflowDefinitionDraftV1, type WorkflowDefinitionEditOpV1,
} from './workflowDefinitionEditV1.js';
import { WorkflowBlockSchema } from './workflowV1.js';

function fixture(): WorkflowDefinitionDraftV1 {
  const first = createWorkflowBlock('step', new Set());
  const second = createWorkflowBlock('step', new Set([first.id]));
  const draft = { name: 'Work', inputs: [], defaults: {}, blocks: [first, second] };
  return setWorkflowStepText(setWorkflowStepText(draft, first.id, 'First'), second.id, 'Second');
}

describe('typed workflow definition edits', () => {
  it('copies evaluated loops with fresh evaluator ids, aggregate paths and iteration scopes while preserving external references and literal data', () => {
    const draft: WorkflowDefinitionDraftV1 = { ...fixture(), blocks: [{ kind: 'loop', id: 'loop', body: [
      { kind: 'step', id: 'producer', document: { text: 'Produce', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      { kind: 'action', id: 'consumer', actionId: 'notifications.notify_me', input: {
        internal: { kind: 'result', producer: { blockId: 'producer', scope: { kind: 'previous_iteration', loopBlockId: 'loop' } }, path: [] },
        external: { kind: 'workspace', producer: { blockId: 'external', scope: { kind: 'outer', levels: 1 } }, field: 'directory' },
        literal: { kind: 'literal', value: { blockId: 'producer', path: ['producer'] } },
      } },
    ], repetition: { kind: 'evaluate', maxIterations: 3, history: 'none', evaluator: {
      kind: 'action', id: 'judge', actionId: 'notifications.notify_me', input: {
        aggregate: { kind: 'result', producer: { blockId: 'loop', scope: { kind: 'current' } }, path: ['last', 'producer'] },
      },
    } } }] };
    const { draft: next, blockId } = duplicateWorkflowBlock(draft, 'loop');
    expect(next.blocks[0]).toBe(draft.blocks[0]);
    const copy = next.blocks[1];
    if (copy?.kind !== 'loop' || copy.repetition.kind !== 'evaluate') throw new Error('Expected evaluated loop copy');
    expect(copy.id).toBe(blockId);
    expect(copy.repetition.evaluator.id).not.toBe('judge');
    expect(copy.body[1]).toMatchObject({ input: {
      internal: { producer: { blockId: copy.body[0]!.id, scope: { loopBlockId: copy.id } } },
      external: { producer: { blockId: 'external', scope: { kind: 'outer', levels: 1 } } },
      literal: { value: { blockId: 'producer', path: ['producer'] } },
    } });
    expect(copy.repetition.evaluator).toMatchObject({ input: { aggregate: {
      producer: { blockId: copy.id }, path: ['last', copy.body[0]!.id],
    } } });
    expect(duplicateWorkflowBlock(draft, 'missing')).toEqual({ draft, blockId: null });
  });
  it('inserts every canonical leaf with optional nested identities and canonical defaults', () => {
    const op = WorkflowDefinitionEditOpV1Schema.parse({
      kind: 'insert_block', list: { kind: 'root' }, block: {
        kind: 'parallel', failurePolicy: 'fail_stop', branches: [{ blocks: [
          { kind: 'action', actionId: 'notifications.notify_me' },
          { kind: 'workflow', workflowRef: 'builtin:review-and-converge' },
          { kind: 'wait', document: { text: 'Check the result', references: [], attachments: [] }, result: { kind: 'text' } },
          { kind: 'if', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [
            { kind: 'wait', id: 'wait-1', document: { text: 'Confirm', references: [], attachments: [] }, result: { kind: 'text' } },
          ] },
          { kind: 'loop', body: [{ kind: 'action', actionId: 'notifications.notify_me', input: {} }],
            repetition: { kind: 'evaluate', maxIterations: 1, history: 'none', evaluator: {
              kind: 'action', actionId: 'notifications.notify_me', input: {},
            } } },
        ] }] },
    });
    const result = applyWorkflowDefinitionEditsV1(fixture(), [op]);
    expect(result).toMatchObject({ ok: true, changedBlockIds: [
      'parallel-1', 'action-1', 'workflow-1', 'wait-2', 'if-1', 'wait-1', 'loop-1', 'action-3', 'action-2',
    ] });
    if (!result.ok) throw new Error('expected successful insertion');
    const inserted = result.draft.blocks.at(-1);
    expect(WorkflowBlockSchema.safeParse(inserted).success).toBe(true);
    if (inserted?.kind !== 'parallel') throw new Error('expected parallel');
    expect(inserted.branches[0]?.id).toBe('branch-1');
    expect(inserted.branches[0]?.blocks.slice(0, 2)).toMatchObject([{ kind: 'action', input: {} }, { kind: 'workflow', input: {} }]);
    expect(inserted.branches[0]?.blocks[3]).toMatchObject({ kind: 'if', otherwise: [] });
    expect(WorkflowInsertBlockV1Schema.safeParse({ kind: 'action', actionId: 'notifications.notify_me', input: {}, unknown: true }).success).toBe(false);
    expect(WorkflowInsertBlockV1Schema.safeParse({ kind: 'wait', id: '', document: { text: 'Check', references: [], attachments: [] }, result: { kind: 'text' } }).success).toBe(false);
    expect(WorkflowInsertBlockV1Schema.safeParse('Check').success).toBe(false);
    expect(WorkflowBlockSchema.safeParse({ kind: 'action', actionId: 'notifications.notify_me', input: {} }).success).toBe(false);
  });

  it('parses and inserts deeply nested optional-id blocks without a recursion limit', () => {
    let block: unknown = { kind: 'step', document: { text: 'Deep leaf', references: [], attachments: [] }, result: { kind: 'text' } };
    for (let index = 0; index < 1200; index += 1) {
      block = { kind: 'loop', repetition: { kind: 'count', count: { kind: 'literal', value: 1 } }, body: [block] };
    }
    const parsed = WorkflowDefinitionEditOpV1Schema.safeParse({ kind: 'insert_block', list: { kind: 'root' }, block });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected valid deep insertion');
    const result = applyWorkflowDefinitionEditsV1(fixture(), [parsed.data]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected successful insertion');
    expect(result.changedBlockIds).toHaveLength(1201);
    expect(result.changedBlockIds.at(-1)).toBe('step-3');
  });

  it('projects optional identities and evaluator restrictions through the canonical Action schema bridge', () => {
    const validate = new Ajv({ strict: false }).compile(WorkflowInsertBlockV1Schema.toJSONSchema({ io: 'input', target: 'draft-7' }));
    const evaluator = { kind: 'action', actionId: 'notifications.notify_me', input: {} };
    const loop = { kind: 'loop', body: [evaluator], repetition: { kind: 'evaluate', maxIterations: 1, history: 'none', evaluator } };
    expect(validate(loop)).toBe(true);
    const invalidEvaluator = { ...loop, repetition: { ...loop.repetition,
      evaluator: { kind: 'workflow', workflowRef: 'builtin:review-and-converge', input: {} },
    } };
    expect(validate(invalidEvaluator)).toBe(false);
    expect(WorkflowInsertBlockV1Schema.safeParse(invalidEvaluator).success).toBe(false);
    expect(validate({ ...loop, body: [{ ...evaluator, unknown: true }] })).toBe(false);
    const cyclic = { kind: 'loop', repetition: { kind: 'count', count: { kind: 'literal', value: 1 } }, body: [] as unknown[] };
    cyclic.body.push(cyclic);
    const parsed = WorkflowInsertBlockV1Schema.safeParse(cyclic);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected cycle rejection');
    expect(parsed.error.issues[0]?.path).toEqual(['body', 0]);
  });

  it('delegates each operation to the editor document owner', () => {
    const draft = fixture();
    const blank = createWorkflowBlock('step', new Set(['step-1', 'step-2']));
    if (blank.kind !== 'step') throw new Error('expected step');
    const block = { ...blank, document: { ...blank.document, text: 'Inserted' } };
    const replacement = { ...draft.blocks[0]!, onlyWhen: { kind: 'exists' as const, value: { kind: 'literal' as const, value: true } } };
    const finalOutput = { kind: 'result' as const, producer: { blockId: 'step-2', scope: { kind: 'current' as const } }, path: [] };
    const inputs = [{ name: 'topic', valueType: 'string' as const, required: true }];
    const cases: readonly [WorkflowDefinitionEditOpV1, WorkflowDefinitionDraftV1][] = [
      [{ kind: 'insert_block', list: { kind: 'root' }, block, afterBlockId: 'step-1' }, insertWorkflowBlock(draft, { list: { kind: 'root' }, block, afterBlockId: 'step-1' })],
      [{ kind: 'replace_block', blockId: 'step-1', block: replacement }, updateWorkflowBlock(draft, 'step-1', () => replacement)],
      [{ kind: 'remove_block', blockId: 'step-1' }, removeWorkflowBlock(draft, 'step-1').draft],
      [{ kind: 'move_block', blockId: 'step-2', direction: 'up' }, moveWorkflowBlock(draft, 'step-2', 'up')],
      [{ kind: 'set_step_prompt', blockId: 'step-1', text: 'New prompt' }, setWorkflowStepText(draft, 'step-1', 'New prompt')],
      [{ kind: 'set_step_setting', blockId: 'step-1', field: 'profileId', value: null }, setWorkflowStepExecutionField(draft, 'step-1', 'profileId', null)],
      [{ kind: 'set_step_setting', blockId: 'step-1', field: 'timeoutMs', value: 1000 }, setWorkflowStepTimeout(draft, 'step-1', 1000)],
      [{ kind: 'set_default', field: 'profileId', value: null }, setWorkflowDefaultField(draft, 'profileId', null)],
      [{ kind: 'set_inputs', inputs }, setWorkflowInputs(draft, inputs)],
      [{ kind: 'set_final_output', finalOutput }, setWorkflowFinalOutput(draft, finalOutput)],
      [{ kind: 'rename', name: 'Renamed' }, { ...draft, name: 'Renamed' }],
    ];
    for (const [op, expected] of cases) {
      const result = applyWorkflowDefinitionEditsV1(draft, [WorkflowDefinitionEditOpV1Schema.parse(op)]);
      expect(result).toMatchObject({ ok: true, draft: expected });
    }
  });

  it('refuses the whole batch at the first unknown block without mutating the input', () => {
    const draft = fixture();
    const before = structuredClone(draft);
    expect(applyWorkflowDefinitionEditsV1(draft, [
      { kind: 'set_step_prompt', blockId: 'step-1', text: 'Changed' },
      { kind: 'remove_block', blockId: 'missing' },
      { kind: 'rename', name: 'Never applied' },
    ])).toEqual({ ok: false, issue: { opIndex: 1, code: 'unknown_block_id' } });
    expect(draft).toEqual(before);
  });

  it('returns surviving changed ids once in operation order and assigns missing nested ids by the editor rule', () => {
    const draft = fixture();
    const inserted = createWorkflowBlock('if', new Set());
    if (inserted.kind !== 'if') throw new Error('expected if');
    const { id: _id, ...withoutId } = inserted;
    const firstChild = inserted.then[0]!;
    if (firstChild.kind !== 'step') throw new Error('expected step');
    const { id: _childId, ...child } = { ...firstChild, document: { ...firstChild.document, text: 'Inserted' } };
    const result = applyWorkflowDefinitionEditsV1(draft, [
      { kind: 'insert_block', list: { kind: 'root' }, block: { ...withoutId, then: [child] } },
      { kind: 'replace_block', blockId: 'step-2', block: { ...draft.blocks[1]!, onlyWhen: { kind: 'exists', value: { kind: 'literal', value: true } } } },
      { kind: 'set_step_prompt', blockId: 'step-1', text: 'Change' },
      { kind: 'move_block', blockId: 'step-2', direction: 'up' },
      { kind: 'set_step_prompt', blockId: 'step-2', text: 'Again' },
      { kind: 'remove_block', blockId: 'step-1' },
      { kind: 'rename', name: 'New' },
    ]);
    expect(result).toMatchObject({ ok: true, changedBlockIds: ['if-1', 'step-3', 'step-2'] });
    expect(draft.blocks.map((entry) => entry.id)).toEqual(['step-1', 'step-2']);
  });

  it('refuses impossible list, anchor, move and non-step targets instead of silently doing nothing', () => {
    const draft = fixture();
    const block = createWorkflowBlock('step', new Set(['step-1', 'step-2']));
    for (const op of [
      { kind: 'insert_block', list: { kind: 'loopBody', loopId: 'step-1' }, block },
      { kind: 'insert_block', list: { kind: 'root' }, block, afterBlockId: 'missing' },
      { kind: 'move_block', blockId: 'step-1', direction: 'up' },
    ] satisfies WorkflowDefinitionEditOpV1[]) {
      expect(applyWorkflowDefinitionEditsV1(draft, [op])).toEqual({ ok: false, issue: { opIndex: 0, code: 'invalid_target' } });
    }
    const container = createWorkflowBlock('loop', new Set());
    expect(applyWorkflowDefinitionEditsV1({ ...draft, blocks: [container] }, [
      { kind: 'set_step_prompt', blockId: container.id, text: 'No' },
    ])).toEqual({ ok: false, issue: { opIndex: 0, code: 'invalid_target' } });
  });

  it('preserves clear versus null and rejects unknown operation and setting fields', () => {
    const draft = setWorkflowStepExecutionField(fixture(), 'step-1', 'profileId', 'profile-1');
    expect(applyWorkflowDefinitionEditsV1(draft, [{ kind: 'set_step_setting', blockId: 'step-1', field: 'profileId' }]))
      .toMatchObject({ ok: true, draft: fixture() });
    for (const op of [
      { kind: 'rename', name: 'New', unexpected: true },
      { kind: 'set_step_setting', blockId: 'step-1', field: 'unknown', value: 'x' },
      { kind: 'set_step_setting', blockId: 'step-1', field: 'timeoutMs', value: 0 },
    ]) expect(WorkflowDefinitionEditOpV1Schema.safeParse(op).success).toBe(false);
  });

  it('creates each step kind as a parseable block with a fresh id, ready for its first edit', () => {
    const taken = new Set(['action-1', 'workflow-1', 'wait-1']);
    const action = createWorkflowLeafBlock({ kind: 'action', actionId: 'notifications.notify_me' }, taken);
    const nested = createWorkflowLeafBlock({ kind: 'workflow', workflowRef: 'builtin:review-and-converge' }, taken);
    const wait = createWorkflowLeafBlock({ kind: 'wait' }, taken);
    expect(action).toMatchObject({ kind: 'action', id: 'action-2', actionId: 'notifications.notify_me', input: {} });
    expect(nested).toMatchObject({ kind: 'workflow', id: 'workflow-2', workflowRef: 'builtin:review-and-converge', input: {} });
    expect(wait).toMatchObject({ kind: 'wait', id: 'wait-2', result: { kind: 'text' } });
    // Like a new Agent step, a Wait for you parses once it says what to do.
    const authoredWait = wait.kind === 'wait' ? { ...wait, document: { ...wait.document, text: 'Check the notes' } } : wait;
    for (const block of [action, nested, authoredWait]) expect(WorkflowBlockSchema.safeParse(block).error?.issues ?? []).toEqual([]);
    // Composition is a Workflow leaf, never a workflow.run.* Action.
    expect(() => createWorkflowLeafBlock({ kind: 'action', actionId: 'workflow.run.start' }, taken)).toThrow();
  });
  it('authors Step options as own properties that clearing deletes, so the block inherits or always runs again', () => {
    const condition = { kind: 'exists' as const, value: { kind: 'literal' as const, value: true } };
    const loop = createWorkflowBlock('loop', new Set(['step-1', 'step-2']));
    const action = createWorkflowLeafBlock({ kind: 'action', actionId: 'notifications.notify_me' }, new Set());
    const draft = { ...fixture(), blocks: [...fixture().blocks, loop, action] };

    const conditioned = setWorkflowBlockOnlyWhen(setWorkflowBlockOnlyWhen(draft, 'step-1', condition), loop.id, condition);
    expect(conditioned.blocks[0]).toMatchObject({ onlyWhen: condition });
    expect(conditioned.blocks[2]).toMatchObject({ onlyWhen: condition });
    expect(setWorkflowBlockOnlyWhen(conditioned, 'step-1', undefined).blocks[0]).not.toHaveProperty('onlyWhen');

    const reviewed = setWorkflowLeafPauseForReview(setWorkflowLeafPauseForReview(draft, 'step-1', true), action.id, true);
    expect(reviewed.blocks[0]).toMatchObject({ pauseForReview: true });
    expect(reviewed.blocks[3]).toMatchObject({ pauseForReview: true });
    // Off is omission, never a stored false.
    expect(setWorkflowLeafPauseForReview(reviewed, 'step-1', false).blocks[0]).not.toHaveProperty('pauseForReview');

    const pinned = setWorkflowStepExecutionTarget(draft, 'step-1', 'detached_run');
    expect(pinned.blocks[0]).toMatchObject({ execution: { executionTarget: { kind: 'detached_run' } } });
    // "Workflow default" deletes the step's own choice (and an emptied execution), so later defaults reach it.
    expect(setWorkflowStepExecutionTarget(pinned, 'step-1', undefined).blocks[0]).not.toHaveProperty('execution');
    expect(WorkflowBlockSchema.safeParse(pinned.blocks[0]).error?.issues ?? []).toEqual([]);

    // An Action's result-wait deadline is authored like a step's.
    expect(setWorkflowStepTimeout(draft, action.id, 5000).blocks[3]).toMatchObject({ timeoutMs: 5000 });
  });
});
