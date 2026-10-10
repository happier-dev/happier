import { describe, expect, it } from 'vitest';

import { WorkflowDefinitionV1Schema, type WorkflowBlock, type WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import { createWorkflowEditorDraft, resolveSelectionAfterRemoval, toggleWorkflowBlockCollapsed, EMPTY_WORKFLOW_EDITOR_VIEW_STATE, type WorkflowEditorDraft } from './workflowEditorDraft';
import * as draftOwner from './workflowEditorDraft';
import { materializeWorkflowStarterExample } from '@happier-dev/protocol/workflows/builtins/examples';
import { WORKFLOW_STARTER_EXAMPLES_V1, AutomationTriggerDefinitionInputSchema } from '@happier-dev/protocol';
import { validateWorkflowEditorDraft } from './workflowAuthoring';
import { collectWorkflowBlockIds, createWorkflowBlock, findWorkflowBlock, findWorkflowBlockListRef, insertWorkflowBlock, moveWorkflowBlock, resolvePreviousResultInputForInsertion, removeWorkflowBlock, setWorkflowDefaultField, setWorkflowFinalOutput, setWorkflowStepExecutionField, setWorkflowStepText, setWorkflowStepTimeout, updateWorkflowBlock, walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

function step(id: string, text = `${id} prompt`): WorkflowStep {
  return { kind: 'step', id, document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } };
}

function draftWith(blocks: readonly WorkflowBlock[]): WorkflowEditorDraft {
  return createWorkflowEditorDraft({ draftId: 'draft-1', blocks });
}

describe('workflow block creation', () => {
  it('keeps an ordinary catalog recipe unchanged without Session context and binds it when that context is supplied', () => {
    const example = WORKFLOW_STARTER_EXAMPLES_V1.find(entry => entry.key === 'ask-once')!;
    const session = { sessionId: 'session-a', machineId: 'machine-a' };
    expect(materializeWorkflowStarterExample(example)).toEqual({ status: 'ready', example });
    const selected = materializeWorkflowStarterExample(example, { session });
    if (selected.status !== 'ready') throw new Error('Expected materialized ordinary recipe');
    expect(selected.example.sessionTarget).toEqual(session);
    expect(selected.example.definition.defaults.conversation).toEqual({ kind: 'existing_session', ...session });
    const inserted = draftOwner.insertWorkflowStarterExample(setWorkflowDefaultField(draftWith([step('existing')]), 'conversation',
      { kind: 'existing_session', sessionId: 'prior-session', machineId: 'prior-machine' }), selected.example);
    expect(inserted.draft.blocks[1]).toMatchObject({ execution: { conversation: { kind: 'existing_session', ...session } } });
    expect(selected.example.trigger).toBeUndefined();
    expect(example.definition.defaults.conversation).toBeUndefined();
    expect(validateWorkflowEditorDraft({ ...selected.example.definition, name: '', draftId: 'ordinary-recipe' }).issues
      .filter(issue => issue.severity === 'error')).toEqual([]);
  });
  it.each(WORKFLOW_STARTER_EXAMPLES_V1)('inserts $key atomically, renaming collisions without changing the catalog or existing work', (example) => {
    const existing = setWorkflowDefaultField(draftWith([step('fix')]), 'agentTarget',
      { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } });
    const before = structuredClone(example.definition);
    const selected = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'machine-a' }, timezone: 'Europe/Zurich' });
    if (selected.status !== 'ready') throw new Error('Expected materialized example');
    const first = draftOwner.insertWorkflowStarterExample(existing, selected.example);
    const second = draftOwner.insertWorkflowStarterExample(first.draft, selected.example);
    expect(second.draft.blocks[0]).toBe(existing.blocks[0]);
    expect(collectWorkflowBlockIds(second.draft).size).toBe(collectWorkflowBlockIds(existing).size
      + 2 * collectWorkflowBlockIds({ ...existing, blocks: example.definition.blocks }).size);
    expect(validateWorkflowEditorDraft(second.draft).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(second.before).toEqual(first.draft);
    expect(example.definition).toEqual(before);
  });
  it('requires a chosen session before materializing session habits, and preserves their trigger with insertion', () => {
    const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'notify-when-agent-waits')!;
    expect(materializeWorkflowStarterExample(example).status).toBe('requires_session');
    const selected = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'machine-a' } });
    if (selected.status !== 'ready') throw new Error('Expected materialized example');
    const inserted = draftOwner.insertWorkflowStarterExample(draftWith([step('existing')]), selected.example);
    expect(inserted.trigger).toMatchObject({ kind: 'sessionLifecycle', sourceSessionId: 'session-a', events: ['userActionRequired'] });
    expect(AutomationTriggerDefinitionInputSchema.safeParse(inserted.trigger).success).toBe(true);
    expect(() => draftOwner.insertWorkflowStarterExample(draftWith([step('existing')]), example)).toThrow('workflow_starter_requires_session');
  });
  it('binds a daily summary to its selected session on a schedule without relying on a firing origin', () => {
    const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'daily-summary-in-session')!;
    const selected = materializeWorkflowStarterExample(example, { session: { sessionId: 'session-a', machineId: 'machine-a' }, timezone: 'Europe/Zurich' });
    if (selected.status !== 'ready') throw new Error('Expected materialized example');
    const inserted = draftOwner.insertWorkflowStarterExample(draftWith([step('existing')]), selected.example);
    expect(inserted.trigger).toMatchObject({ kind: 'schedule', schedule: { timezone: 'Europe/Zurich' } });
    expect(inserted.draft.blocks[1]).toMatchObject({ execution: { conversation: { kind: 'existing_session', sessionId: 'session-a', machineId: 'machine-a' } } });
    if (inserted.draft.blocks[1]?.kind !== 'step') throw new Error('Expected ordinary summary step');
    expect(inserted.draft.blocks[1].execution).not.toHaveProperty('engine');
    expect(inserted.draft.blocks[1].execution).not.toHaveProperty('permissionMode');
    expect(inserted.draft.defaults.conversation).toBeUndefined();
    expect(AutomationTriggerDefinitionInputSchema.safeParse(inserted.trigger).success).toBe(true);
    expect(example.definition.defaults.conversation).toEqual({ kind: 'origin_session' });
  });
  it('materializes editable memory upkeep in the current Bot session with its normal model and permissions', () => {
    const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'memory-upkeep-in-session');
    expect(example).toBeDefined();
    if (!example) throw new Error('Missing memory upkeep template');
    const selected = materializeWorkflowStarterExample(example, {
      session: { sessionId: 'bot-session', machineId: 'bot-machine' }, timezone: 'Europe/Zurich',
    });
    if (selected.status !== 'ready') throw new Error('Expected materialized upkeep');
    const inserted = draftOwner.insertWorkflowStarterExample(draftWith([{ ...step('existing'), execution: {
      conversation: { kind: 'existing_session', sessionId: 'prior-session', machineId: 'prior-machine' },
    } }]), selected.example);
    expect(inserted.trigger).toMatchObject({ kind: 'schedule', enabled: true, schedule: { timezone: 'Europe/Zurich' } });
    expect(inserted.sessionTarget).toEqual({ sessionId: 'bot-session', machineId: 'bot-machine' });
    const upkeep = inserted.draft.blocks[1];
    expect(upkeep).toMatchObject({ kind: 'step', execution: {
      conversation: { kind: 'existing_session', sessionId: 'bot-session', machineId: 'bot-machine' },
    } });
    if (upkeep?.kind !== 'step') throw new Error('Expected ordinary agent step');
    expect(upkeep.execution).not.toHaveProperty('engine');
    expect(upkeep.execution).not.toHaveProperty('permissionMode');
    expect(upkeep.document.text).toContain('memory.remember');
    expect(upkeep.document.text).toContain('memory.update');
    expect(upkeep.document.text).toContain('memory.forget');
    expect(validateWorkflowEditorDraft(inserted.draft).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(WorkflowDefinitionV1Schema.safeParse(example.definition).success).toBe(true);
  });
  it('assigns a stable id at object creation so no block enters the optional-id dialect', () => {
    const first = createWorkflowBlock('step', new Set<string>());
    expect(first.id).toBe('step-1');
    const second = createWorkflowBlock('step', new Set([first.id]));
    expect(second.id).toBe('step-2');
  });

  it('creates a parallel group with two distinct branch ids and explicit failure policy', () => {
    const block = createWorkflowBlock('parallel', new Set<string>());
    expect(block.kind).toBe('parallel');
    if (block.kind !== 'parallel') throw new Error('unreachable');
    expect(block.failurePolicy).toBe('fail_stop');
    expect(new Set(block.branches.map((branch) => branch.id)).size).toBe(2);
  });

  it('never reuses an id already taken anywhere in the draft', () => {
    const draft = draftWith([createWorkflowBlock('parallel', new Set<string>())]);
    const taken = collectWorkflowBlockIds(draft);
    const next = createWorkflowBlock('step', taken);
    expect(taken.has(next.id)).toBe(false);
  });
});

describe('workflow block list addressing', () => {
  const parallel = createWorkflowBlock('parallel', new Set<string>());
  const draft = draftWith([step('analyze'), parallel, step('publish')]);

  it('finds the owning list of a nested block', () => {
    if (parallel.kind !== 'parallel') throw new Error('unreachable');
    const nested = parallel.branches[0]!.blocks[0]!;
    expect(findWorkflowBlockListRef(draft, nested.id)).toEqual({
      kind: 'parallelBranch',
      parallelId: parallel.id,
      branchId: parallel.branches[0]!.id,
    });
    expect(findWorkflowBlockListRef(draft, 'analyze')).toEqual({ kind: 'root' });
  });

  it('walks evaluator steps as addressable blocks', () => {
    const loop: WorkflowBlock = {
      kind: 'loop',
      id: 'judge',
      repetition: {
        kind: 'evaluate',
        maxIterations: 2,
        history: 'latest',
        evaluator: { ...step('judge-step'), result: { kind: 'decision', decisions: ['continue', 'stop'] } },
      },
      body: [step('work')],
    };
    const ids = walkWorkflowBlocks([loop]).map((block) => block.id);
    expect(ids).toContain('judge-step');
    expect(findWorkflowBlock(draftWith([loop]), 'judge-step')).not.toBeNull();
  });
});

describe('workflow structural editing', () => {
  it('inserts after the requested anchor inside the requested scope', () => {
    const parallel = createWorkflowBlock('parallel', new Set<string>());
    if (parallel.kind !== 'parallel') throw new Error('unreachable');
    const branchId = parallel.branches[0]!.id;
    const draft = draftWith([step('analyze'), parallel]);
    const inserted = insertWorkflowBlock(draft, {
      list: { kind: 'parallelBranch', parallelId: parallel.id, branchId },
      block: step('extra'),
    });
    const nextParallel = findWorkflowBlock(inserted, parallel.id);
    if (nextParallel?.kind !== 'parallel') throw new Error('unreachable');
    expect(nextParallel.branches[0]!.blocks.map((block) => block.id)).toEqual([
      parallel.branches[0]!.blocks[0]!.id,
      'extra',
    ]);
  });

  it('keeps untouched siblings referentially identical so one edit cannot rerender the rest', () => {
    const analyze = step('analyze');
    const implement = step('implement');
    const draft = draftWith([analyze, implement]);
    const edited = setWorkflowStepText(draft, 'implement', 'new text');
    expect(edited).not.toBe(draft);
    expect(edited.blocks[0]).toBe(analyze);
    expect(edited.blocks[1]).not.toBe(implement);
  });

  it('patches one row in a 100-step draft without replacing any untouched subtree', () => {
    const blocks = Array.from({ length: 100 }, (_unused, index) => step(`step-${index}`));
    const draft = draftWith(blocks);

    const edited = setWorkflowStepText(draft, 'step-50', 'edited prompt');

    expect(edited.blocks).not.toBe(draft.blocks);
    expect(edited.blocks[50]).not.toBe(draft.blocks[50]);
    for (let index = 0; index < draft.blocks.length; index += 1) {
      if (index === 50) continue;
      expect(edited.blocks[index], `step-${index}`).toBe(draft.blocks[index]);
    }
  });

  it('returns the same draft when an update changes nothing', () => {
    const draft = draftWith([step('analyze', 'same')]);
    expect(setWorkflowStepText(draft, 'analyze', 'same')).toBe(draft);
    expect(updateWorkflowBlock(draft, 'missing', (block) => block)).toBe(draft);
  });

  it('reorders without changing ids so references survive the move', () => {
    const draft = draftWith([step('a'), step('b'), step('c')]);
    const moved = moveWorkflowBlock(draft, 'c', 'up');
    expect(moved.blocks.map((block) => block.id)).toEqual(['a', 'c', 'b']);
    expect(findWorkflowBlock(moved, 'c')).toEqual(findWorkflowBlock(draft, 'c'));
    expect(moveWorkflowBlock(draft, 'a', 'up')).toBe(draft);
  });

  it('moves a block into the container above it and back out after that container', () => {
    const loop = createWorkflowBlock('loop', new Set<string>());
    const draft = draftWith([loop, step('after')]);
    const nested = moveWorkflowBlock(draft, 'after', 'in');
    expect(nested.blocks.map((block) => block.id)).toEqual([loop.id]);
    expect(findWorkflowBlockListRef(nested, 'after')).toEqual({ kind: 'loopBody', loopId: loop.id });

    const lifted = moveWorkflowBlock(nested, 'after', 'out');
    expect(lifted.blocks.map((block) => block.id)).toEqual([loop.id, 'after']);
  });

  it('generates blocks whose only departure from the strict definition schema is the unauthored prompt', () => {
    const kinds = ['step', 'parallel', 'loop', 'if'] as const;
    const asDefinition = (draft: WorkflowEditorDraft) => ({
      version: 1,
      inputs: draft.inputs,
      defaults: draft.defaults,
      blocks: draft.blocks,
    });
    for (const kind of kinds) {
      const generated = draftWith([createWorkflowBlock(kind, new Set<string>())]);

      // A generated step is deliberately unauthored, and the canonical document
      // schema requires a non-empty prompt. That rejection is the contract the
      // editor surfaces as `prompt_required` — so it must be the ONLY reason a
      // freshly generated block is not yet a definition, and it must be
      // reported against the step's own document text.
      const unauthored = WorkflowDefinitionV1Schema.safeParse(asDefinition(generated));
      expect(unauthored.success).toBe(false);
      const issuePaths = unauthored.success
        ? []
        : unauthored.error.issues.map((issue) => issue.path.join('.'));
      expect(issuePaths.length).toBeGreaterThan(0);
      expect(issuePaths.every((path) => path.endsWith('document.text'))).toBe(true);

      const authored = walkWorkflowBlocks(generated.blocks)
        .filter((block) => block.kind === 'step')
        .reduce(
          (draft, block) => setWorkflowStepText(draft, block.id, `${block.id} prompt`),
          generated,
        );
      expect(WorkflowDefinitionV1Schema.safeParse(asDefinition(authored)).success).toBe(true);
    }
  });

  it('removal clears a final output that named the removed block and reports the removed block', () => {
    const draft = setWorkflowFinalOutput(draftWith([step('a'), step('b')]), {
      kind: 'result',
      producer: { blockId: 'b', scope: { kind: 'current' } },
      path: [],
    });
    const result = removeWorkflowBlock(draft, 'b');
    expect(result.removed?.id).toBe('b');
    expect(result.draft).not.toHaveProperty('finalOutput');
    expect(result.draft.blocks.map((block) => block.id)).toEqual(['a']);
  });

  it('removal leaves an unrelated final output intact', () => {
    const draft = setWorkflowFinalOutput(draftWith([step('a'), step('b')]), {
      kind: 'result',
      producer: { blockId: 'a', scope: { kind: 'current' } },
      path: [],
    });
    const result = removeWorkflowBlock(draft, 'b');
    expect(result.draft.finalOutput?.producer.blockId).toBe('a');
  });

  it('relocating the selected final-output producer keeps the selection, in and back out', () => {
    const loop = createWorkflowBlock('loop', new Set<string>());
    const draft = setWorkflowFinalOutput(draftWith([loop, step('after')]), {
      kind: 'result',
      producer: { blockId: 'after', scope: { kind: 'current' } },
      path: [],
    });

    const nested = moveWorkflowBlock(draft, 'after', 'in');
    expect(findWorkflowBlockListRef(nested, 'after')).toEqual({ kind: 'loopBody', loopId: loop.id });
    expect(nested.finalOutput?.producer.blockId).toBe('after');

    const lifted = moveWorkflowBlock(nested, 'after', 'out');
    expect(lifted.blocks.map((block) => block.id)).toEqual([loop.id, 'after']);
    expect(lifted.finalOutput?.producer.blockId).toBe('after');
  });
});

describe('previous-result default at the insertion point', () => {
  it('names the step immediately before the insertion point in the same scope', () => {
    const draft = draftWith([step('analyze'), step('implement')]);
    expect(resolvePreviousResultInputForInsertion(draft, { list: { kind: 'root' }, afterBlockId: 'analyze' }))
      .toEqual({ kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] });
    expect(resolvePreviousResultInputForInsertion(draft, { list: { kind: 'root' } }))
      .toEqual({ kind: 'result', producer: { blockId: 'implement', scope: { kind: 'current' } }, path: [] });
  });

  it('resolves inside the nested scope the insertion actually targets', () => {
    const loop = createWorkflowBlock('loop', new Set<string>());
    if (loop.kind !== 'loop') throw new Error('unreachable');
    const bodyStepId = loop.body[0]!.id;
    const draft = draftWith([step('outer'), loop]);
    expect(resolvePreviousResultInputForInsertion(draft, { list: { kind: 'loopBody', loopId: loop.id } }))
      .toEqual({ kind: 'result', producer: { blockId: bodyStepId, scope: { kind: 'current' } }, path: [] });
  });

  it('supplies no default when the previous block is not one unambiguous producer', () => {
    const parallel = createWorkflowBlock('parallel', new Set<string>());
    const draft = draftWith([parallel]);
    expect(resolvePreviousResultInputForInsertion(draft, { list: { kind: 'root' } })).toBeNull();
    expect(resolvePreviousResultInputForInsertion(draftWith([]), { list: { kind: 'root' } })).toBeNull();
  });
});

describe('workflow override semantics', () => {
  it('records an override equal to the current default as an explicit override', () => {
    const base = setWorkflowDefaultField(draftWith([step('a')]), 'permissionMode', 'default');
    const overridden = setWorkflowStepExecutionField(base, 'a', 'permissionMode', 'default');
    const block = overridden.blocks[0] as WorkflowStep;
    expect(block.execution).toEqual({ permissionMode: 'default' });
  });

  it('removes the override, and then the empty execution object, when the step inherits again', () => {
    const base = setWorkflowStepExecutionField(draftWith([step('a')]), 'a', 'profileId', 'reviewer');
    const inherited = setWorkflowStepExecutionField(base, 'a', 'profileId', undefined);
    expect(inherited.blocks[0]).not.toHaveProperty('execution');
  });

  it('keeps an explicit null override distinct from inheritance', () => {
    const draft = setWorkflowStepExecutionField(draftWith([step('a')]), 'a', 'profileId', null);
    const block = draft.blocks[0] as WorkflowStep;
    expect(block.execution).toEqual({ profileId: null });
    expect(Object.hasOwn(block.execution ?? {}, 'profileId')).toBe(true);
  });

  /**
   * An authored timeout is an explicit observation deadline; omission means no
   * workflow deadline. The draft records exactly the value chosen and removes
   * the key on clear, so a saved definition never carries a default duration.
   */
  it('records an explicit step timeout and omits the key entirely when cleared', () => {
    const base = draftWith([step('a')]);
    const withTimeout = setWorkflowStepTimeout(base, 'a', 90_000);
    expect((withTimeout.blocks[0] as WorkflowStep).timeoutMs).toBe(90_000);
    expect(WorkflowDefinitionV1Schema.safeParse({
      version: 1, inputs: [], defaults: {}, blocks: withTimeout.blocks,
    }).success).toBe(true);

    const cleared = setWorkflowStepTimeout(withTimeout, 'a', undefined);
    expect(cleared.blocks[0]).not.toHaveProperty('timeoutMs');
    expect(setWorkflowStepTimeout(base, 'a', undefined)).toBe(base);
    expect(setWorkflowStepTimeout(withTimeout, 'a', 90_000)).toBe(withTimeout);
  });

  it('removes a workflow default without disturbing the rest', () => {
    const draft = setWorkflowDefaultField(
      setWorkflowDefaultField(draftWith([step('a')]), 'profileId', 'reviewer'),
      'permissionMode',
      'read_only',
    );
    const cleared = setWorkflowDefaultField(draft, 'profileId', undefined);
    expect(cleared.defaults).toEqual({ permissionMode: 'read_only' });
  });
});

describe('workflow editor view state', () => {
  it('collapse is a view fact and never touches authored content', () => {
    const collapsed = toggleWorkflowBlockCollapsed(EMPTY_WORKFLOW_EDITOR_VIEW_STATE, 'a');
    expect(collapsed.collapsedBlockIds.has('a')).toBe(true);
    expect(toggleWorkflowBlockCollapsed(collapsed, 'a').collapsedBlockIds.has('a')).toBe(false);
  });

  it('moves selection to a surviving meaningful control after a removal', () => {
    const draft = draftWith([step('a'), step('b'), step('c')]);
    expect(resolveSelectionAfterRemoval({ draftBeforeRemoval: draft, removedBlockId: 'b' })).toBe('c');
    expect(resolveSelectionAfterRemoval({ draftBeforeRemoval: draft, removedBlockId: 'c' })).toBe('b');

    const loop = createWorkflowBlock('loop', new Set<string>());
    if (loop.kind !== 'loop') throw new Error('unreachable');
    const onlyChild = loop.body[0]!.id;
    const nestedDraft = draftWith([loop]);
    expect(resolveSelectionAfterRemoval({ draftBeforeRemoval: nestedDraft, removedBlockId: onlyChild }))
      .toBe(loop.id);
  });
});
