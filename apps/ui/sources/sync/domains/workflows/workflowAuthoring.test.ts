import { describe, expect, it } from 'vitest';

import { WorkflowDefinitionV1Schema, type WorkflowBlock, type WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';

import {
  bindWorkflowTriggerEvidenceInputs,
  buildWorkflowEditorDraftFromDefinition,
  buildWorkflowRunStartInputs,
  firstBlockingWorkflowIssue,
  listWorkflowFinalOutputOptions,
  listWorkflowProducerOptions,
  listWorkflowStepOverriddenFields,
  projectWorkflowRunInputFields,
  resolveEffectiveWorkflowStepExecution,
  resolveWorkflowExportBlockedReason,
  resolveWorkflowIssueBlockId,
  resolveWorkflowReferenceScopeFacts,
  resolveWorkflowRunBlockedReason,
  resolveWorkflowSaveBlockedReason,
  resolveWorkflowStepFieldInheritance,
  validateWorkflowEditorDraft,
  workflowIssuesForBlock,
} from './workflowAuthoring';
import { createWorkflowEditorDraft, type WorkflowEditorDraft } from './workflowEditorDraft';
import { collectWorkflowBlockIds, createWorkflowBlock, setWorkflowDefaultField, setWorkflowInputs, setWorkflowStepExecutionField, setWorkflowStepText } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

const CLAUDE_AGENT_TARGET = {
  kind: 'agent' as const,
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function step(id: string, text = `${id} prompt`, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    kind: 'step',
    id,
    document: { text, references: [], attachments: [] },
    input: [],
    result: { kind: 'text' },
    ...extra,
  };
}

function draftWith(blocks: readonly WorkflowBlock[]): WorkflowEditorDraft {
  return setWorkflowDefaultField(
    createWorkflowEditorDraft({ draftId: 'draft-1', name: 'Review', blocks }),
    'agentTarget',
    CLAUDE_AGENT_TARGET,
  );
}

describe('draft validation through the canonical validator', () => {
  it('keeps portable role declarations in the current draft admitted by Run now', () => {
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [],
      defaults: { engine: { role: 'portable_builder' } }, blocks: [step('build')],
      roles: [{ roleId: 'portable_builder', name: 'Builder', instructions: 'Build carefully', runsAs: { kind: 'session' } }],
    });
    const draft = buildWorkflowEditorDraftFromDefinition({ draftId: 'draft-1', name: 'Portable', definition });
    const validation = validateWorkflowEditorDraft(draft);
    expect(validation.valid).toBe(true);
    expect(validation.normalizedDefinition?.roles).toEqual(definition.roles);
  });
  it('accepts an ordinary two-step draft and returns the normalized definition', () => {
    const draft = draftWith([step('analyze'), step('implement')]);
    const validation = validateWorkflowEditorDraft(draft);
    expect(validation.valid).toBe(true);
    expect(validation.normalizedDefinition?.blocks.map((block) => block.id)).toEqual(['analyze', 'implement']);
  });

  it('reports an empty prompt as blocking and locates it at the exact step', () => {
    const draft = setWorkflowStepText(draftWith([step('analyze')]), 'analyze', '');
    const validation = validateWorkflowEditorDraft(draft);
    expect(validation.valid).toBe(false);
    const first = firstBlockingWorkflowIssue(validation);
    expect(first?.path).toContain('/blocks/0');
  });

  /**
   * A structural parse issue names only its path. Resolving that path to the
   * innermost authored block is what lets an empty nested prompt or an
   * unresolved number be shown and focused at its block, not only at the page.
   */
  it('resolves a path-only structural issue to its innermost authored block', () => {
    const loop = createWorkflowBlock('loop', new Set<string>());
    if (loop.kind !== 'loop') throw new Error('unreachable');
    const parallel = createWorkflowBlock('parallel', new Set<string>([loop.id, ...loop.body.map((block) => block.id)]));
    if (parallel.kind !== 'parallel') throw new Error('unreachable');
    const nested = parallel.branches[1]!.blocks[0]!;
    const draft = draftWith([step('a'), { ...loop, body: [step('inside')] }, { ...parallel, maxConcurrent: Number.NaN }]);

    expect(resolveWorkflowIssueBlockId(draft, { path: '/blocks/1/body/0/document/text' })).toBe('inside');
    expect(resolveWorkflowIssueBlockId(draft, { path: `/blocks/2/branches/1/blocks/0/document/text` })).toBe(nested.id);
    expect(resolveWorkflowIssueBlockId(draft, { path: '/blocks/2/maxConcurrent' })).toBe(parallel.id);
    expect(resolveWorkflowIssueBlockId(draft, { path: '/inputs/0/default' })).toBeNull();
    expect(resolveWorkflowIssueBlockId(draft, { path: '/blocks/9/document/text', blockId: 'explicit' })).toBe('explicit');

    const validation = validateWorkflowEditorDraft(draft);
    expect(workflowIssuesForBlock(validation, parallel.id, draft).map((issue) => issue.code))
      .toContain('invalid_max_concurrent');
  });

  it('attributes a reference issue to the consuming block so the editor can show it in place', () => {
    const draft = draftWith([step('analyze', 'a', {
      input: [{ kind: 'result', producer: { blockId: 'ghost', scope: { kind: 'current' } }, path: [] }],
    })]);
    const validation = validateWorkflowEditorDraft(draft);
    expect(workflowIssuesForBlock(validation, 'analyze').map((issue) => issue.code)).toContain('missing_reference');
    expect(workflowIssuesForBlock(validation, 'other')).toEqual([]);
  });

  it('round-trips a definition back into an editable draft without losing inputs or final output', () => {
    const original = draftWith([step('analyze'), step('implement')]);
    const withInputs = setWorkflowInputs(original, [
      { name: 'topic', valueType: 'string', required: true },
    ]);
    const validation = validateWorkflowEditorDraft({
      ...withInputs,
      finalOutput: { kind: 'result', producer: { blockId: 'implement', scope: { kind: 'current' } }, path: [] },
    });
    expect(validation.valid).toBe(true);

    const reopened = buildWorkflowEditorDraftFromDefinition({
      draftId: 'draft-2',
      name: 'Review',
      definition: validation.normalizedDefinition!,
    });
    expect(reopened.inputs.map((input) => input.name)).toEqual(['topic']);
    expect(reopened.finalOutput?.producer.blockId).toBe('implement');
    expect(validateWorkflowEditorDraft(reopened).valid).toBe(true);
  });

  /**
   * The three fields the editor renders but could not author until their option
   * sources reached the Workflow host. A value chosen for one of them has to
   * survive the same normalize → export → reopen path every other authored
   * value does, with the Team-resource binding and the Agent-bound runtime
   * descriptor intact rather than flattened to a string or dropped as unknown.
   */
  it('round-trips Connected Service, terminal and runtime-descriptor selections without collapse', () => {
    const teamBinding = {
      source: 'team_resource' as const,
      resourceId: 'res-1',
      deliveryMode: 'brokered' as const,
    };
    const connectedServices = {
      v: 2 as const,
      bindingsByServiceId: {
        'happier.connect.github/github': teamBinding,
        'happier.connect.linear/linear': { source: 'native' as const },
      },
    };
    const terminal = { mode: 'tmux' as const, tmux: { sessionName: 'review', isolated: true } };
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'claude',
      agent: { backendMode: 'server', home: 'connectedService' as const, connectedServiceId: 'github' },
    };

    const base = draftWith([step('analyze'), step('implement')]);
    const withDefaults = setWorkflowDefaultField(
      setWorkflowDefaultField(
        setWorkflowDefaultField(base, 'connectedServices', connectedServices),
        'terminal',
        terminal,
      ),
      'runtimeDescriptorV1',
      runtimeDescriptorV1,
    );
    // An override equal to the current default stays an explicit override, and
    // an explicit null is an authored "none", not inheritance.
    const withOverrides = setWorkflowStepExecutionField(
      setWorkflowStepExecutionField(withDefaults, 'implement', 'terminal', terminal),
      'implement',
      'connectedServices',
      null,
    );

    const validation = validateWorkflowEditorDraft(withOverrides);
    expect(validation.issues.map((issue) => issue.code)).toEqual([]);
    expect(validation.valid).toBe(true);

    const reopened = buildWorkflowEditorDraftFromDefinition({
      draftId: 'draft-3',
      name: 'Review',
      definition: validation.normalizedDefinition!,
    });

    expect(reopened.defaults.connectedServices).toEqual(connectedServices);
    expect(reopened.defaults.terminal).toEqual(terminal);
    expect(reopened.defaults.runtimeDescriptorV1).toEqual(runtimeDescriptorV1);

    const reopenedStep = reopened.blocks[1] as WorkflowStep;
    expect(reopenedStep.execution?.terminal).toEqual(terminal);
    expect(resolveWorkflowStepFieldInheritance(reopenedStep, 'terminal')).toBe('override');
    expect(reopenedStep.execution?.connectedServices).toBeNull();
    expect(resolveWorkflowStepFieldInheritance(reopenedStep, 'connectedServices')).toBe('override');
    // Untouched by this step, so it still inherits the workflow default.
    expect(resolveWorkflowStepFieldInheritance(reopenedStep, 'runtimeDescriptorV1')).toBe('inherited');
    expect(resolveEffectiveWorkflowStepExecution(reopened, reopenedStep).runtimeDescriptorV1)
      .toEqual(runtimeDescriptorV1);

    expect(validateWorkflowEditorDraft(reopened).valid).toBe(true);
  });
});

describe('inheritance projection', () => {
  it('distinguishes inherited, overridden and explicitly-null fields', () => {
    const base = setWorkflowDefaultField(draftWith([step('a')]), 'profileId', 'reviewer');
    expect(resolveWorkflowStepFieldInheritance(base.blocks[0] as WorkflowStep, 'profileId')).toBe('inherited');

    const overridden = setWorkflowStepExecutionField(base, 'a', 'profileId', 'auditor');
    expect(resolveWorkflowStepFieldInheritance(overridden.blocks[0] as WorkflowStep, 'profileId')).toBe('override');

    const explicitNull = setWorkflowStepExecutionField(base, 'a', 'profileId', null);
    expect(resolveWorkflowStepFieldInheritance(explicitNull.blocks[0] as WorkflowStep, 'profileId')).toBe('override');
  });

  it('keeps an override equal to the current default explicit when the default later changes', () => {
    const base = setWorkflowDefaultField(draftWith([step('a'), step('b')]), 'permissionMode', 'default');
    const withEqualOverride = setWorkflowStepExecutionField(base, 'a', 'permissionMode', 'default');
    const changed = setWorkflowDefaultField(withEqualOverride, 'permissionMode', 'read_only');

    const explicit = changed.blocks[0] as WorkflowStep;
    const inherited = changed.blocks[1] as WorkflowStep;
    expect(resolveEffectiveWorkflowStepExecution(changed, explicit).permissionMode).toBe('default');
    expect(resolveEffectiveWorkflowStepExecution(changed, inherited).permissionMode).toBe('read_only');
  });

  it('lists overridden fields in the canonical chip order', () => {
    const draft = setWorkflowStepExecutionField(
      setWorkflowStepExecutionField(draftWith([step('a')]), 'a', 'profileId', 'x'),
      'a',
      'permissionMode',
      'read_only',
    );
    expect(listWorkflowStepOverriddenFields(draft.blocks[0] as WorkflowStep))
      .toEqual(['profileId', 'permissionMode']);
  });
});

describe('reference vocabulary', () => {
  it('offers only producers that complete before the consumer in its own scope', () => {
    const draft = draftWith([step('a', '\n  Analyze the repository  \nmore detail'), step('b'), step('c')]);
    expect(listWorkflowProducerOptions(draft, 'b')).toEqual([expect.objectContaining({
      blockId: 'a',
      isBranch: false,
      scope: { kind: 'current' },
    })]);
    expect(listWorkflowProducerOptions(draft, 'a')).toEqual([]);
  });

  it('keeps exact authored ids and branch identity for structural producers', () => {
    const parallel = createWorkflowBlock('parallel', new Set<string>());
    if (parallel.kind !== 'parallel') throw new Error('unreachable');
    const draft = draftWith([parallel, step('report')]);
    const options = listWorkflowProducerOptions(draft, 'report');
    expect(options).toContainEqual(expect.objectContaining({ blockId: parallel.id, isBranch: false }));
    for (const branch of parallel.branches) {
      expect(options).toContainEqual(expect.objectContaining({ blockId: branch.id, isBranch: true }));
    }
  });

  it('offers preceding enclosing-scope producers to a nested consumer, not later siblings', () => {
    const loop = createWorkflowBlock('loop', new Set<string>());
    if (loop.kind !== 'loop') throw new Error('unreachable');
    const nested = loop.body[0]!.id;
    const draft = draftWith([step('before'), loop, step('after')]);
    const options = listWorkflowProducerOptions(draft, nested);
    expect(options).toContainEqual(expect.objectContaining({
      blockId: 'before',
      scope: { kind: 'outer', levels: 1 },
    }));
    expect(options.map((option) => option.blockId)).not.toContain('after');
  });

  it('offers the completed prior iteration of an enclosing loop as an explicit scope', () => {
    const loop = createWorkflowBlock('loop', new Set<string>());
    if (loop.kind !== 'loop') throw new Error('unreachable');
    const first = loop.body[0]!;
    const second = step('second');
    const draft = draftWith([{ ...loop, body: [first, second] }]);

    expect(listWorkflowProducerOptions(draft, first.id)).toContainEqual(expect.objectContaining({
      blockId: 'second',
      scope: { kind: 'previous_iteration', loopBlockId: loop.id },
    }));
  });

  it('offers only root-level producers for the final output', () => {
    const loop = createWorkflowBlock('loop', new Set<string>());
    if (loop.kind !== 'loop') throw new Error('unreachable');
    const draft = draftWith([step('a'), loop]);
    const options = listWorkflowFinalOutputOptions(draft).map((option) => option.blockId);
    expect(options).toEqual(['a', loop.id]);
    expect(options).not.toContain(loop.body[0]!.id);
  });

  /**
   * Item and iteration facts exist only inside a loop, and the current item
   * only inside a for-each loop. The picker mirrors the canonical validator's
   * scope rule so it never offers a reference the validator would then reject.
   */
  it('offers item and iteration references only in the scopes the validator accepts', () => {
    const items = createWorkflowBlock('loop', new Set<string>());
    if (items.kind !== 'loop') throw new Error('unreachable');
    const itemsLoop = {
      ...items,
      repetition: {
        kind: 'items' as const,
        items: { kind: 'literal' as const, value: ['a'] },
        execution: 'sequential' as const,
        failurePolicy: 'fail_stop' as const,
      },
    };
    const count = createWorkflowBlock('loop', new Set<string>([itemsLoop.id, itemsLoop.body[0]!.id]));
    if (count.kind !== 'loop') throw new Error('unreachable');
    const draft = draftWith([step('root'), itemsLoop, count]);

    expect(resolveWorkflowReferenceScopeFacts(draft, 'root')).toEqual({ insideLoop: false, insideItemsLoop: false, insideParallel: false });
    expect(resolveWorkflowReferenceScopeFacts(draft, itemsLoop.body[0]!.id))
      .toEqual({ insideLoop: true, insideItemsLoop: true, insideParallel: false });
    expect(resolveWorkflowReferenceScopeFacts(draft, count.body[0]!.id))
      .toEqual({ insideLoop: true, insideItemsLoop: false, insideParallel: false });
    // A loop's own entry-time count/items source resolves in the enclosing
    // scope, so the loop's current item is not available to it.
    expect(resolveWorkflowReferenceScopeFacts(draft, itemsLoop.id)).toEqual({ insideLoop: false, insideItemsLoop: false, insideParallel: false });
    // Its after-each-round consumer resolves inside the body with every body
    // member complete, exactly as the validator scopes `stopWhen`.
    expect(resolveWorkflowReferenceScopeFacts(draft, itemsLoop.id, { continuation: true }))
      .toEqual({ insideLoop: true, insideItemsLoop: true, insideParallel: false });
    // A parallel branch member runs beside its siblings; the group itself does not.
    const parallel = createWorkflowBlock('parallel', collectWorkflowBlockIds(draft));
    if (parallel.kind !== 'parallel') throw new Error('unreachable');
    const withParallel = draftWith([step('root'), parallel]);
    const branchMember = parallel.branches[0]!.blocks[0]!;
    expect(resolveWorkflowReferenceScopeFacts(withParallel, branchMember.id).insideParallel).toBe(true);
    expect(resolveWorkflowReferenceScopeFacts(withParallel, parallel.id).insideParallel).toBe(false);
    expect(listWorkflowProducerOptions(draft, itemsLoop.id, { continuation: true }))
      .toContainEqual(expect.objectContaining({ blockId: itemsLoop.body[0]!.id, scope: { kind: 'current' } }));
    expect(listWorkflowProducerOptions(draft, itemsLoop.id).map((option) => option.blockId))
      .not.toContain(itemsLoop.body[0]!.id);
  });
});

describe('command eligibility', () => {
  /**
   * A numeric field whose text is not yet a number is recorded in the draft
   * as an unresolved number, so the one canonical validator — not a second
   * editor-local rule — blocks every command with a path-addressed issue.
   */
  it('lets the canonical validator block every command on an unresolved authored number', () => {
    const parallel = createWorkflowBlock('parallel', new Set<string>());
    if (parallel.kind !== 'parallel') throw new Error('unreachable');
    const draft = draftWith([{
      ...parallel,
      maxConcurrent: Number.NaN,
      branches: parallel.branches.map((branch) => ({
        ...branch,
        blocks: branch.blocks.map((block) => (block.kind === 'step' ? step(block.id) : block)),
      })),
    }]);
    const validation = validateWorkflowEditorDraft(draft);
    expect(validation.valid).toBe(false);
    expect(firstBlockingWorkflowIssue(validation)).toMatchObject({
      code: 'invalid_max_concurrent',
      path: `/blocks/0/maxConcurrent`,
    });
    expect(resolveWorkflowRunBlockedReason({ validation, targetResolved: true })).toBe('definition_invalid');
    expect(resolveWorkflowSaveBlockedReason({ draft, validation })).toBe('definition_invalid');
    expect(resolveWorkflowExportBlockedReason({ validation })).toBe('definition_invalid');
  });
});

describe('declared inputs and the Run-now sheet', () => {
  const inputs = [
    { name: 'topic', valueType: 'string' as const, required: true, description: 'Subject' },
    { name: 'depth', valueType: 'number' as const, required: false, default: 2 },
  ];

  it('preserves declaration order and marks required gaps as blocking in place', () => {
    const fields = projectWorkflowRunInputFields({ inputs, values: {} });
    expect(fields.map((field) => field.definition.name)).toEqual(['topic', 'depth']);
    expect(fields[0]).toMatchObject({ blocking: true, errorCode: 'missing_required_input' });
    expect(fields[1]).toMatchObject({ blocking: false, value: 2 });
  });

  it('type-checks supplied values against the declared type', () => {
    const fields = projectWorkflowRunInputFields({ inputs, values: { topic: 'auth', depth: 'deep' } });
    expect(fields[0]?.blocking).toBe(false);
    expect(fields[1]).toMatchObject({ blocking: true, errorCode: 'invalid_input' });
  });

  it('sends only values that exist, including pre-filled defaults', () => {
    const fields = projectWorkflowRunInputFields({ inputs, values: { topic: 'auth' } });
    expect(buildWorkflowRunStartInputs(fields)).toEqual({ topic: 'auth', depth: 2 });
    expect(buildWorkflowRunStartInputs(projectWorkflowRunInputFields({ inputs: [], values: {} }))).toBeUndefined();
  });

  it('binds trigger evidence by name and reports unbound required inputs', () => {
    const bound = bindWorkflowTriggerEvidenceInputs({ inputs, evidence: { topic: 'release' } });
    expect(bound.values).toEqual({ topic: 'release', depth: 2 });
    expect(bound.unbound).toEqual([]);

    const missing = bindWorkflowTriggerEvidenceInputs({ inputs, evidence: {} });
    expect(missing.unbound).toEqual(['topic']);
    expect(missing.values).toEqual({ depth: 2 });
  });
});

describe('save eligibility', () => {
  it('names a missing workflow name before anything else', () => {
    const draft = { ...draftWith([step('a')]), name: '  ' };
    expect(resolveWorkflowSaveBlockedReason({ draft, validation: validateWorkflowEditorDraft(draft) }))
      .toBe('name_required');
  });

  it('blocks Save on staged media with its own specific reason rather than a generic invalid', () => {
    const draft = draftWith([{
      kind: 'step',
      id: 'a',
      document: {
        text: 'look',
        references: [],
        attachments: [{
          v: 1,
          instanceId: 'attachment-1',
          attachment: { pluginId: 'happier.media', localId: 'image' },
          key: 'image-1',
          value: { url: 'staged' },
          presentation: { label: 'Screenshot', typeLabel: 'Image' },
          content: { kind: 'stagedMedia', transferId: 'transfer-1' },
        }],
      },
      input: [],
      result: { kind: 'text' },
    } as unknown as WorkflowBlock]);
    expect(resolveWorkflowSaveBlockedReason({ draft, validation: validateWorkflowEditorDraft(draft) }))
      .toBe('unsupported_persisted_attachment');
  });

  it('allows Save for a valid named draft', () => {
    const draft = draftWith([step('a')]);
    expect(resolveWorkflowSaveBlockedReason({ draft, validation: validateWorkflowEditorDraft(draft) }))
      .toBeNull();
  });
});
