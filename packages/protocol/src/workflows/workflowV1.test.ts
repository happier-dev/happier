import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';

import {
  WorkflowDefinitionSchema,
  WorkflowBlockSchema,
  WorkflowInsertBlockV1Schema,
  WorkflowIngressSchema,
  WorkflowSessionAuthoringSelectionSchema,
  WorkflowInputDefinitionSchema,
  WorkflowStepSchema,
  workflowInputToFieldHint,
  type WorkflowDefinitionV1,
} from './workflowV1.js';
import {
  assignWorkflowIngressBlockId,
  normalizeWorkflowIngress,
  validateWorkflowDefinition,
} from './workflowValidationV1.js';
import {
  parseWorkflowDocumentJsonIngressV1,
  parseWorkflowDocumentJsonV1,
  serializeWorkflowDocumentJsonV1,
} from './workflowDocumentV1.js';
import { WorkflowBlockIdProtocolSchema } from './workflowBlockIdProtocol.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { createDeepWorkflowDefinition, deepWorkflowLeafPath } from './workflowDefinition.testkit.js';
import { WorkflowConditionSchema, type WorkflowCondition } from './workflowReferenceV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

const CLAUDE_AGENT_TARGET = {
  kind: 'agent' as const,
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function textStep(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'step' as const,
    id,
    document: { text, references: [], attachments: [] },
    ...extra,
  };
}

function codesOf(result: ReturnType<typeof validateWorkflowDefinition>): string[] {
  return result.issues.map((issue) => issue.code);
}

describe('workflow input option sources', () => {
  it('adapts declared choices without importing Workflow defaults into field selection', () => {
    expect(workflowInputToFieldHint({ name: 'channel', valueType: 'string', required: true,
      optionsSourceId: 'notifications.channels.available' })).toMatchObject({
        path: 'channel', widget: 'select', required: true, requireExplicitSelection: true,
        optionsSourceId: 'notifications.channels.available',
      });
    expect(workflowInputToFieldHint({ name: 'mode', valueType: 'string', required: false,
      default: 'safe', enum: ['safe', 'fast'] }, { title: 'Mode', optionLabels: { safe: 'Safe mode' } }))
      .toEqual({ path: 'mode', title: 'Mode', widget: 'select', required: false, requireExplicitSelection: true,
        options: [{ value: 'safe', label: 'Safe mode' }, { value: 'fast', label: 'fast' }] });
    expect(WorkflowInputDefinitionSchema.safeParse({ name: 'channel', valueType: 'string', required: true,
      default: 'push', optionsSourceId: 'notifications.channels.available' }).success).toBe(false);
  });
  it('preserves a declared string enum and rejects incompatible types and defaults', () => {
    const input = { name: 'apply', valueType: 'string', required: false, default: 'fix', enum: ['fix', 'report'] };
    expect(WorkflowInputDefinitionSchema.parse(input)).toEqual(input);
    expect(WorkflowInputDefinitionSchema.safeParse({ ...input, default: 'anything' }).success).toBe(false);
    expect(WorkflowInputDefinitionSchema.safeParse({ ...input, valueType: 'json' }).success).toBe(false);
  });
  it('uses registered Action option sources as picker aids without replacing value types', () => {
    const definition = { defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
      inputs: [{ name: 'reviewers', valueType: 'json', required: false, optionsSourceId: 'review.engines.available' }],
      blocks: [textStep('work', 'Work')] };
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(true);
    expect(result.normalizedDefinition?.inputs[0]).toMatchObject({ valueType: 'json', optionsSourceId: 'review.engines.available' });
    expect(codesOf(validateWorkflowDefinition({ ...definition,
      inputs: [{ ...definition.inputs[0], optionsSourceId: 'unregistered.options' }] }))).toContain('invalid_input');
  });
});

describe('workflow definition normalization', () => {
  it('round-trips authored names on every block kind while stored readers drop unknown fields', () => {
    const leaf = textStep('work', 'Prompt');
    const blocks = [leaf,
      { kind: 'action', id: 'notify', actionId: 'notifications.notify_me' },
      { kind: 'workflow', id: 'child', workflowRef: 'builtin:keep-going' },
      { kind: 'wait', id: 'hold', document: leaf.document },
      { kind: 'parallel', id: 'panel', failurePolicy: 'fail_stop', branches: [{ id: 'lane', blocks: [leaf] }] },
      { kind: 'loop', id: 'repeat', body: [leaf], repetition: { kind: 'count', count: { kind: 'literal', value: 2 } } },
      { kind: 'if', id: 'choice', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [leaf] },
    ];
    const name = 'Authored name '.repeat(12).trim();
    for (const block of blocks) {
      const named = WorkflowBlockSchema.parse({ ...block, name: `  ${name}  ` });
      expect(named).toMatchObject({ name });
      expect(WorkflowBlockSchema.parse(JSON.parse(JSON.stringify(named)))).toEqual(named);
      expect(createStoredReadSchema(WorkflowBlockSchema).parse({ ...named, futureField: true })).toEqual(named);
      expect(WorkflowBlockSchema.safeParse({ ...named, futureField: true }).success).toBe(false);
      expect(createStoredReadSchema(WorkflowBlockSchema).safeParse({ ...named, name: 12 }).success).toBe(false);
      expect(WorkflowBlockSchema.parse({ ...block, name: '  ' })).not.toHaveProperty('name');
      const { id: _id, ...insert } = block;
      expect(WorkflowInsertBlockV1Schema.parse({ ...insert, name: '  ' })).not.toHaveProperty('name');
      expect(WorkflowBlockSchema.parse(block)).not.toHaveProperty('name');
    }
    const evaluator = WorkflowBlockSchema.parse({ kind: 'loop', id: 'evaluate', name: 'Check progress', body: [leaf],
      repetition: { kind: 'evaluate', maxIterations: 2, history: 'none', evaluator: { ...leaf, id: 'judge', name: '  Judge  ' } } });
    expect(evaluator).toMatchObject({ repetition: { evaluator: { name: 'Judge' } } });
    const blankEvaluator = { kind: 'loop', id: 'evaluate', body: [leaf], repetition: {
      kind: 'evaluate', maxIterations: 2, history: 'none', evaluator: { ...leaf, id: 'judge', name: '  ' },
    } };
    expect(WorkflowBlockSchema.parse(blankEvaluator)).not.toHaveProperty('repetition.evaluator.name');
    expect(WorkflowInsertBlockV1Schema.parse(blankEvaluator)).not.toHaveProperty('repetition.evaluator.name');
    expect(WorkflowStepSchema.parse({ ...leaf, name: '  ' })).not.toHaveProperty('name');
  });

  it('admits deeply nested conditions without imposing a nesting limit', () => {
    let condition: WorkflowCondition = { kind: 'exists', value: { kind: 'literal', value: true } };
    for (let depth = 0; depth < 12_000; depth += 1) {
      condition = depth % 3 === 0 ? { kind: 'not', condition }
        : { kind: depth % 3 === 1 ? 'all' : 'any', conditions: [condition] };
    }
    expect(WorkflowDefinitionSchema.safeParse({ version: 1,
      blocks: [textStep('work', 'Work', { onlyWhen: condition })] }).success).toBe(true);
    expect(sameStrictJsonValue(WorkflowConditionSchema.parse(condition), condition)).toBe(true);
    expect(WorkflowConditionSchema.safeParse({ kind: 'not', condition, unknownField: true }).success).toBe(false);
    const opened = createStoredReadSchema(WorkflowConditionSchema).parse({ kind: 'not', condition, unknownField: true });
    expect(sameStrictJsonValue(opened, { kind: 'not', condition })).toBe(true);
    expect(createStoredReadSchema(WorkflowConditionSchema).parse({ kind: 'not', extension: true,
      condition: { kind: 'exists', value: { kind: 'literal', value: true }, extension: true } }))
      .toEqual({ kind: 'not', condition: { kind: 'exists', value: { kind: 'literal', value: true } } });
  });

  it('keeps item counter references path-free and reports their lexical scope', () => {
    const outOfScope = validateWorkflowDefinition({ defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('root', 'Work', { input: [{ kind: 'item', field: 'count' }] })] });
    expect(codesOf(outOfScope)).toContain('invalid_reference_scope');
    const inScope = validateWorkflowDefinition({ defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{ kind: 'loop', id: 'items', repetition: { kind: 'items',
        items: { kind: 'literal', value: ['A'] }, execution: 'sequential', failurePolicy: 'fail_stop' },
        body: [textStep('work', 'Work', { input: [{ kind: 'item', field: 'count' }] })] }] });
    expect(inScope.valid).toBe(true);
    expect(inScope.normalizedDefinition?.blocks[0]).toMatchObject({ body: [{ input: [{ kind: 'item', field: 'count' }] }] });
  });
  it('normalizes role-backed Agent and non-Agent leaves through the canonical owner', () => {
    const result = validateWorkflowDefinition({ version: 1,
      roles: [{ roleId: 'builder', name: 'Builder', instructions: 'Build carefully', runsAs: { kind: 'session' } }],
      defaults: { engine: { role: 'builder' } },
      blocks: [textStep('build', 'Build'),
        { kind: 'action', id: 'notify', actionId: 'user.notify', input: { message: { kind: 'literal', value: 'Done' } } },
        { kind: 'workflow', id: 'child', workflowRef: 'builtin:keep-going', input: {} },
        { kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }],
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(WorkflowDefinitionSchema.safeParse(result.normalizedDefinition).success).toBe(true);
  });
  it('accepts portable origin conversation selection without embedded Session authority', () => {
    const originStep = textStep('origin', 'Continue the originating conversation', {
      input: [], result: { kind: 'text' }, execution: { conversation: { kind: 'origin_session' } },
    });
    expect(WorkflowStepSchema.safeParse(originStep).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ ...originStep,
      execution: { conversation: { kind: 'origin_session', sessionId: 'literal-origin' } },
    }).success).toBe(false);
  });
  it('rejects cyclic block input without rejecting repeated acyclic branches', () => {
    const loop = { kind: 'loop', id: 'loop', repetition: { kind: 'count', count: { kind: 'literal', value: 1 } }, body: [] as unknown[] };
    loop.body.push(loop);
    const parsed = WorkflowBlockSchema.safeParse(loop);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected cyclic block rejection');
    expect(parsed.error.issues[0]?.path).toEqual(['body', 0]);
    const leaf = textStep('work', 'Work');
    expect(WorkflowBlockSchema.safeParse({ ...loop, body: [leaf, leaf] }).success).toBe(true);
  });
  it('advertises recursive canonical block constraints to Action schema consumers', () => {
    const jsonSchema = WorkflowBlockSchema.toJSONSchema({ io: 'input', target: 'draft-7' });
    const validate = new Ajv({ strict: false }).compile(jsonSchema);
    expect(validate(createDeepWorkflowDefinition(12).blocks[0])).toBe(true);
    expect(validate({ kind: 'if', id: 'gate', when: { kind: 'exists', value: { kind: 'literal', value: true } },
      then: [textStep('bad', 'Work', { timeoutMs: 0 })], otherwise: [] })).toBe(false);
    expect(validate({ kind: 'loop', id: 'loop', body: ['Work'], repetition: { kind: 'count', count: { kind: 'literal', value: 1 } } })).toBe(false);
    expect(validate(textStep('work', 'Work', { unknown: true }))).toBe(false);
    const condition = { kind: 'all', conditions: [{ kind: 'not', condition: {
      kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true }, right: { kind: 'literal', value: false },
    } }] };
    expect(validate(textStep('work', 'Work', { onlyWhen: condition }))).toBe(true);
    expect(validate(textStep('work', 'Work', { onlyWhen: { ...condition, conditions: [
      { kind: 'not', condition: { kind: 'exists', value: { kind: 'literal', value: true }, extra: true } },
    ] } }))).toBe(false);
  });
  it('parses deep canonical structure and ingress with the same defaults and overrides', () => {
    const definition = createDeepWorkflowDefinition();
    const canonical = WorkflowDefinitionSchema.parse(definition);
    const ingress = WorkflowIngressSchema.parse(definition);
    const normalized = validateWorkflowDefinition(ingress);
    expect(normalized.valid).toBe(true);
    expect(sameStrictJsonValue(canonical, normalized.normalizedDefinition)).toBe(true);
    expect(sameStrictJsonValue(ingress, canonical)).toBe(true);
  });

  it('keeps canonical requirements distinct from shorthand ingress', () => {
    expect(WorkflowDefinitionSchema.safeParse({ version: 1, blocks: ['Work'] }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ blocks: [textStep('work', 'Work')] }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({ version: 1, blocks: [{ kind: 'step', document: { text: 'Work' } }] }).success).toBe(false);
    expect(validateWorkflowDefinition({ blocks: ['Work'] }, { context: { agentTarget: CLAUDE_AGENT_TARGET } }).valid).toBe(true);
  });

  it('retains the exact malformed deep child path at canonical and ingress boundaries', () => {
    const definition = createDeepWorkflowDefinition();
    const path = deepWorkflowLeafPath();
    let leaf: unknown = definition;
    for (const segment of path) leaf = (leaf as Record<string | number, unknown>)[segment];
    (leaf as Record<string, unknown>).timeoutMs = 0;
    const parsed = WorkflowDefinitionSchema.safeParse(definition);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected invalid timeout');
    expect(parsed.error.issues.map((issue) => issue.path)).toContainEqual([...path, 'timeoutMs']);
    const normalized = normalizeWorkflowIngress(definition);
    expect(normalized.kind).toBe('issues');
    if (normalized.kind !== 'issues') throw new Error('expected invalid timeout');
    expect(normalized.issues.map((issue) => issue.path)).toContain(`/${[...path, 'timeoutMs'].join('/')}`);
  });

  it('round-trips deep canonical definitions through document export and import', () => {
    const definition = createDeepWorkflowDefinition();
    const serialized = serializeWorkflowDocumentJsonV1({ kind: 'happier.workflow', version: 1, definition });
    const imported = parseWorkflowDocumentJsonV1(serialized);
    expect(sameStrictJsonValue(imported.definition, definition)).toBe(true);
  });
  it('rejects a terminal newline in an authored block identity', () => {
    expect(WorkflowBlockIdProtocolSchema.safeParse('analyze\n').success).toBe(false);
  });

  it('expands a prompt-only string block into one canonical step with a deterministic id', () => {
    const result = validateWorkflowDefinition(
      { version: 1, defaults: { agentTarget: CLAUDE_AGENT_TARGET }, blocks: ['Analyze the repository.'] },
    );

    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    const blocks = result.normalizedDefinition?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'step',
      id: 'wf--step-0',
      document: { text: 'Analyze the repository.', references: [], attachments: [] },
      input: [],
      result: { kind: 'text' },
    });
    expect(blocks[0]).not.toHaveProperty('execution');
  });

  it('expands a prompt-only string at every block-list position with a scoped id', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [
        {
          kind: 'parallel',
          id: 'checks',
          failurePolicy: 'collect_outcomes',
          branches: [{ id: 'lint', blocks: ['Run the linter'] }],
        },
        {
          kind: 'loop',
          id: 'each',
          repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
          body: ['Do the work'],
        },
        {
          kind: 'if',
          id: 'gate',
          when: { kind: 'exists', value: { kind: 'literal', value: true } },
          then: ['Handle the true case'],
          otherwise: ['Handle the other case'],
        },
      ],
    });

    expect(result.issues).toEqual([]);
    const blocks = result.normalizedDefinition?.blocks ?? [];
    const parallel = blocks[0] as { branches: ReadonlyArray<{ blocks: ReadonlyArray<{ id: string }> }> };
    const loop = blocks[1] as { body: ReadonlyArray<{ id: string }> };
    const conditional = blocks[2] as { then: ReadonlyArray<{ id: string }>; otherwise: ReadonlyArray<{ id: string }> };

    expect(parallel.branches[0]!.blocks[0]!.id).toBe('wf-checks_lint-step-0');
    expect(loop.body[0]!.id).toBe('wf-each_body-step-0');
    expect(conditional.then[0]!.id).toBe('wf-gate_then-step-0');
    expect(conditional.otherwise[0]!.id).toBe('wf-gate_otherwise-step-0');
  });

  it('never lets an assigned nested id collide with an authored id elsewhere', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [
        textStep('wf-each_body-step-0', 'Authored first'),
        {
          kind: 'loop',
          id: 'each',
          repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
          body: ['Assigned second'],
        },
      ],
    });
    expect(result.issues).toEqual([]);
    const loop = result.normalizedDefinition?.blocks[1] as { body: ReadonlyArray<{ id: string }> };
    expect(loop.body[0]!.id).toBe('wf-each_body-step-0-2');
  });

  it('keeps the ingress dialect structurally identical to the definition apart from strings', () => {
    // Guards the one deliberate duplication: the ingress union exists only to
    // permit prompt-only strings, so any structured block the definition accepts
    // must round-trip through ingress unchanged, and vice versa.
    const structured = {
      version: 1,
      inputs: [],
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [
        {
          kind: 'parallel',
          id: 'checks',
          failurePolicy: 'collect_outcomes',
          maxConcurrent: 2,
          branches: [{ id: 'lint', blocks: [textStep('run-lint', 'lint')] }],
        },
        {
          kind: 'if',
          id: 'gate',
          when: { kind: 'exists', value: { kind: 'literal', value: true } },
          then: [textStep('yes', 'yes')],
          otherwise: [],
        },
      ],
    };

    const asDefinition = WorkflowDefinitionSchema.safeParse(structured);
    const asIngress = WorkflowIngressSchema.safeParse(structured);
    expect(asDefinition.success).toBe(true);
    expect(asIngress.success).toBe(true);
    expect(asIngress.data).toEqual(asDefinition.data);

    // A block the definition rejects is rejected by ingress too.
    const invalid = { ...structured, blocks: [{ kind: 'parallel', id: 'x', branches: [] }] };
    expect(WorkflowDefinitionSchema.safeParse(invalid).success).toBe(false);
    expect(WorkflowIngressSchema.safeParse(invalid).success).toBe(false);
  });

  it('is idempotent: re-normalizing an assigned id produces the same definition', () => {
    const first = validateWorkflowDefinition(
      { defaults: { agentTarget: CLAUDE_AGENT_TARGET }, blocks: ['One', 'Two'] },
    );
    const second = validateWorkflowDefinition(first.normalizedDefinition);
    expect(second.normalizedDefinition).toEqual(first.normalizedDefinition);
    expect(second.valid).toBe(true);
  });

  it('never renames an authored object id and suffixes only on a real collision', () => {
    const taken = new Set(['wf--step-0']);
    expect(assignWorkflowIngressBlockId({ parentPath: '', ordinal: 0, takenIds: taken })).toBe('wf--step-0-2');
    expect(assignWorkflowIngressBlockId({ parentPath: '', ordinal: 1, takenIds: taken })).toBe('wf--step-1');

    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('wf--step-0', 'Authored'), 'Ingress'],
    });
    const ids = (result.normalizedDefinition?.blocks ?? []).map((block) => block.id);
    expect(ids).toEqual(['wf--step-0', 'wf--step-1']);
  });

  it('inherits the trusted calling Session Agent only when the definition has none', () => {
    const withoutAgent = validateWorkflowDefinition({ blocks: ['Analyze'] });
    expect(withoutAgent.valid).toBe(false);
    expect(codesOf(withoutAgent)).toContain('target_unavailable');

    const withContext = validateWorkflowDefinition(
      { blocks: ['Analyze'] },
      { context: { agentTarget: CLAUDE_AGENT_TARGET, machineId: 'machine-1' } },
    );
    expect(withContext.valid).toBe(true);
    expect(withContext.normalizedDefinition?.defaults.agentTarget).toEqual(CLAUDE_AGENT_TARGET);

    // An explicit authored value wins; the host context never overwrites it.
    const other = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const withAuthored = validateWorkflowDefinition(
      { defaults: { agentTarget: other }, blocks: ['Analyze'] },
      { context: { agentTarget: CLAUDE_AGENT_TARGET } },
    );
    expect(withAuthored.normalizedDefinition?.defaults.agentTarget).toEqual(other);
  });

  it('enforces the canonical block-id grammar without inventing a length quota', () => {
    const missingId = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{ kind: 'step', document: { text: 'x' } }],
    });
    expect(missingId.valid).toBe(false);
    expect(codesOf(missingId)).toContain('invalid_id');

    const unknownField = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', { nope: true })],
    });
    expect(codesOf(unknownField)).toContain('unknown_field');

    const reserved = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('$root', 'x')],
    });
    expect(reserved.valid).toBe(false);
    expect(codesOf(reserved)).toContain('invalid_id');

    const longButValidId = `step_${'a'.repeat(300)}`;
    const withoutInventedLengthQuota = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep(longButValidId, 'x')],
    });
    expect(withoutInventedLengthQuota.issues).toEqual([]);
    expect(withoutInventedLengthQuota.normalizedDefinition?.blocks[0]?.id).toBe(longButValidId);
  });

  it('rejects a parallel display-name field outside the canonical definition', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('named', 'x', { displayName: 'Display name' })],
    });
    expect(result.valid).toBe(false);
    expect(codesOf(result)).toContain('unknown_field');
  });

  it('reports a duplicate id once with its exact path', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('same', 'a'), textStep('same', 'b')],
    });
    const duplicate = result.issues.filter((issue) => issue.code === 'duplicate_id');
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]?.path).toBe('/blocks/1/id');
    expect(duplicate[0]?.blockId).toBe('same');
  });

  it('preserves an omitted step timeout as no authored deadline', () => {
    const explicit = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('timed', 'x', { timeoutMs: 60_000 })],
    });
    expect(explicit.issues).toEqual([]);
    expect(explicit.normalizedDefinition?.blocks[0]).toMatchObject({ timeoutMs: 60_000 });

    // Omission must survive normalization unchanged: an omitted authored
    // timeout means "no authored observation deadline" and must never be
    // normalized to a fallback value by this schema.
    const omitted = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: ['Analyze'],
    });
    expect(omitted.issues).toEqual([]);
    expect(omitted.normalizedDefinition?.blocks[0]).not.toHaveProperty('timeoutMs');

    const baseStep = {
      kind: 'step' as const,
      id: 'a',
      document: { text: 'x', references: [], attachments: [] },
    };
    for (const timeoutMs of [0, -1_000, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(WorkflowStepSchema.safeParse({ ...baseStep, timeoutMs }).success).toBe(false);
    }
  });
});

describe('workflow reference scopes', () => {
  const linear: unknown = {
    version: 1,
    inputs: [{ name: 'topic', valueType: 'string', required: true, description: 'Subject to analyze' }],
    defaults: { agentTarget: CLAUDE_AGENT_TARGET, conversation: { kind: 'shared_run' } },
    blocks: [
      textStep('analyze', 'Analyze the supplied topic and list risks.', {
        input: [{ kind: 'input', name: 'topic' }],
        result: { kind: 'text' },
      }),
      textStep('implement', 'Implement the safe plan from the supplied analysis.', {
        input: [
          { kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] },
          { kind: 'workspace', producer: { blockId: 'analyze', scope: { kind: 'current' } }, field: 'directory' },
        ],
        result: { kind: 'text' },
      }),
    ],
    finalOutput: { kind: 'result', producer: { blockId: 'implement', scope: { kind: 'current' } }, path: [] },
  };

  it('accepts the canonical linear two-step definition', () => {
    const result = validateWorkflowDefinition(linear);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.normalizedDefinition?.finalOutput?.producer.blockId).toBe('implement');
  });

  it('rejects a forward reference and an unknown producer with distinct codes', () => {
    const forward = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [
        textStep('a', 'first', {
          input: [{ kind: 'result', producer: { blockId: 'b', scope: { kind: 'current' } } }],
        }),
        textStep('b', 'second'),
      ],
    });
    expect(codesOf(forward)).toContain('invalid_reference_scope');

    const unknown = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', {
        input: [{ kind: 'result', producer: { blockId: 'ghost', scope: { kind: 'current' } } }],
      })],
    });
    expect(codesOf(unknown)).toContain('missing_reference');
  });

  it('rejects a reference to an undeclared input', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', { input: [{ kind: 'input', name: 'missing' }] })],
    });
    expect(codesOf(result)).toContain('missing_reference');
    expect(result.issues[0]?.path).toBe('/blocks/0/input/0/name');
  });

  it('accepts the nested parallel-items plus evaluator example verbatim', () => {
    const result = validateWorkflowDefinition({
      version: 1,
      inputs: [{ name: 'files', valueType: 'json', required: true }],
      defaults: { agentTarget: CLAUDE_AGENT_TARGET, conversation: { kind: 'fresh' } },
      blocks: [
        {
          kind: 'loop',
          id: 'review-files',
          repetition: {
            kind: 'items',
            items: { kind: 'input', name: 'files' },
            execution: 'parallel',
            failurePolicy: 'collect_outcomes',
            maxConcurrent: 4,
          },
          body: [
            textStep('inspect', 'Inspect the current item and report findings.', {
              input: [{ kind: 'item', field: 'value' }],
              result: {
                kind: 'json',
                schema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] },
              },
            }),
            textStep('repair', 'Apply a repair only when inspection did not pass.', {
              input: [
                { kind: 'item', field: 'value' },
                { kind: 'result', producer: { blockId: 'inspect', scope: { kind: 'current' } }, path: [] },
              ],
              result: { kind: 'text' },
              onlyWhen: {
                kind: 'compare',
                operator: 'eq',
                left: { kind: 'result', producer: { blockId: 'inspect', scope: { kind: 'current' } }, path: ['passed'] },
                right: { kind: 'literal', value: false },
              },
            }),
          ],
        },
        {
          kind: 'loop',
          id: 'judge',
          repetition: {
            kind: 'evaluate',
            maxIterations: 3,
            history: 'latest',
            evaluator: textStep('judge-step', 'Continue only if unresolved risk remains.', {
              input: [{ kind: 'result', producer: { blockId: 'review-files', scope: { kind: 'outer', levels: 1 } }, path: [] }],
              result: { kind: 'decision', decisions: ['continue', 'stop'] },
            }),
          },
          body: [
            textStep('summarize', 'Summarize the collected file outcomes.', {
              execution: { conversation: { kind: 'shared_run' } },
              input: [{ kind: 'result', producer: { blockId: 'review-files', scope: { kind: 'outer', levels: 1 } }, path: [] }],
              result: { kind: 'text' },
            }),
          ],
        },
        textStep('publish', 'Return the final review summary.', {
          input: [{ kind: 'result', producer: { blockId: 'judge', scope: { kind: 'current' } }, path: [] }],
          result: { kind: 'text' },
        }),
      ],
      finalOutput: { kind: 'result', producer: { blockId: 'publish', scope: { kind: 'current' } }, path: [] },
    });

    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects the current item outside a for-each loop and an out-of-range outer scope', () => {
    const item = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', { input: [{ kind: 'item', field: 'value' }] })],
    });
    expect(codesOf(item)).toContain('invalid_reference_scope');

    const outer = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [
        textStep('first', 'x'),
        textStep('second', 'y', {
          input: [{ kind: 'result', producer: { blockId: 'first', scope: { kind: 'outer', levels: 2 } } }],
        }),
      ],
    });
    expect(codesOf(outer)).toContain('invalid_reference_scope');
  });

  it('resolves previous_iteration only for an enclosing loop', () => {
    const build = (loopBlockId: string) => validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop',
        id: 'each',
        repetition: { kind: 'count', count: { kind: 'literal', value: 3 } },
        body: [
          textStep('work', 'do work'),
          textStep('review', 'review', {
            input: [{ kind: 'result', producer: { blockId: 'work', scope: { kind: 'previous_iteration', loopBlockId } } }],
          }),
        ],
      }],
    });

    expect(build('each').issues).toEqual([]);
    expect(codesOf(build('nope'))).toContain('invalid_reference_scope');
  });

  it('rejects a final output that is nested inside another block', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop',
        id: 'each',
        repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
        body: [textStep('inner', 'x')],
      }],
      finalOutput: { kind: 'result', producer: { blockId: 'inner', scope: { kind: 'current' } }, path: [] },
    });
    expect(codesOf(result)).toContain('invalid_reference_scope');
  });

  it('rejects previous parallel items even at concurrency one while preserving nested sequential loops', () => {
    const previous = (blockId: string, loopBlockId: string) => ({
      kind: 'result', producer: { blockId, scope: { kind: 'previous_iteration', loopBlockId } },
    });
    const build = (execution: 'parallel' | 'sequential', nested: boolean) => validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop', id: 'each',
        repetition: {
          kind: 'items', items: { kind: 'literal', value: ['A', 'A', 'B'] },
          execution, failurePolicy: 'fail_stop', ...(execution === 'parallel' ? { maxConcurrent: 1 } : {}),
        },
        body: nested ? [{
          kind: 'loop', id: 'inner', repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
          body: [textStep('work', 'work', { input: [previous('work', 'inner')] })],
        }] : [textStep('work', 'work', { input: [previous('work', 'each')] })],
      }],
    });
    expect(codesOf(build('parallel', false))).toContain('invalid_reference_scope');
    expect(build('sequential', false).issues).toEqual([]);
    expect(build('parallel', true).issues).toEqual([]);
  });

  it('accepts optional result inputs and refuses them in conditions, final output and loop sources', () => {
    const optional = { kind: 'result', producer: { blockId: 'source', scope: { kind: 'current' } }, path: [], optional: true };
    const build = (extra: Record<string, unknown>, finalOutput?: unknown) => validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('source', 'source'), textStep('consumer', 'consume', extra)],
      ...(finalOutput === undefined ? {} : { finalOutput }),
    });
    expect(build({ input: [optional] }).issues).toEqual([]);
    expect(codesOf(build({ onlyWhen: { kind: 'exists', value: optional } }))).toContain('invalid_reference_scope');
    expect(codesOf(build({}, optional))).toContain('invalid_reference_scope');
    const loop = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('source', 'source'), {
        kind: 'loop', id: 'loop', repetition: { kind: 'count', count: optional }, body: [textStep('work', 'work')],
      }],
    });
    expect(codesOf(loop)).toContain('invalid_reference_scope');
  });

  it('binds trailing counts to a prior producer in the nearest loop body', () => {
    const count = {
      kind: 'loop_trailing_count', producer: { blockId: 'check', scope: { kind: 'current' } },
      path: ['verdict'], equals: 'no_progress',
    };
    const inside = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop', id: 'rounds',
        repetition: { kind: 'until', maxIterations: 4, stopWhen: {
          kind: 'compare', operator: 'gte', left: count, right: { kind: 'literal', value: 3 },
        } },
        body: [textStep('check', 'check'), {
          kind: 'if', id: 'gate', when: { kind: 'exists', value: { kind: 'literal', value: true } },
          then: [textStep('report', 'report', { input: [count] })],
        }],
      }],
    });
    expect(inside.issues).toEqual([]);
    const outside = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('check', 'check'), textStep('report', 'report', { input: [count] })],
    });
    expect(codesOf(outside)).toContain('invalid_reference_scope');
  });

  it('keeps trailing-count producers inside the nearest loop and types counts as numbers', () => {
    const count = {
      kind: 'loop_trailing_count', producer: { blockId: 'check', scope: { kind: 'current' } },
      path: ['verdict'], equals: 'no_progress',
    };
    const build = (left: unknown, right: unknown) => validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('root-check', 'root'), {
        kind: 'loop', id: 'outer-loop',
        repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
        body: [textStep('outer-check', 'outer'), {
          kind: 'loop', id: 'inner-loop',
          repetition: { kind: 'until', maxIterations: 3, stopWhen: {
            kind: 'compare', operator: 'gte', left, right,
          } },
          body: [textStep('check', 'check')],
        }],
      }],
    });
    expect(build(count, { kind: 'literal', value: 2 }).issues).toEqual([]);
    expect(codesOf(build(count, { kind: 'literal', value: '2' }))).toContain('invalid_condition');
    expect(codesOf(build({
      ...count, producer: { blockId: 'outer-check', scope: { kind: 'outer', levels: 1 } },
    }, { kind: 'literal', value: 2 }))).toContain('invalid_reference_scope');
    expect(codesOf(build({
      ...count, producer: { blockId: 'check', scope: { kind: 'previous_iteration', loopBlockId: 'inner-loop' } },
    }, { kind: 'literal', value: 2 }))).toContain('invalid_reference_scope');
  });

  it('keeps the authored final output stable regardless of block ordering in the response', () => {
    const result = validateWorkflowDefinition(linear);
    const reversedIssueOrder = validateWorkflowDefinition({
      ...(result.normalizedDefinition as WorkflowDefinitionV1),
      blocks: [...(result.normalizedDefinition?.blocks ?? [])],
    });
    expect(reversedIssueOrder.normalizedDefinition?.finalOutput?.producer.blockId).toBe('implement');
  });
});

describe('workflow container policies', () => {
  it('persists explicit failure policy and container concurrency, and rejects concurrency on sequential items', () => {
    const parallel = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'parallel',
        id: 'checks',
        failurePolicy: 'collect_outcomes',
        maxConcurrent: 2,
        branches: [
          { id: 'left', blocks: [textStep('a', 'x')] },
          { id: 'right', blocks: [textStep('b', 'y')] },
        ],
      }],
    });
    expect(parallel.issues).toEqual([]);
    const block = parallel.normalizedDefinition?.blocks[0];
    expect(block).toMatchObject({ failurePolicy: 'collect_outcomes', maxConcurrent: 2 });

    const omitted = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'parallel',
        id: 'checks',
        failurePolicy: 'fail_stop',
        branches: [{ id: 'only', blocks: [textStep('a', 'x')] }],
      }],
    });
    expect(omitted.issues).toEqual([]);
    expect(omitted.normalizedDefinition?.blocks[0]).not.toHaveProperty('maxConcurrent');

    const sequential = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop',
        id: 'each',
        repetition: {
          kind: 'items',
          items: { kind: 'literal', value: [1, 2] },
          execution: 'sequential',
          failurePolicy: 'fail_stop',
          maxConcurrent: 3,
        },
        body: [textStep('inner', 'x')],
      }],
    });
    expect(codesOf(sequential)).toContain('invalid_max_concurrent');
  });

  it('lets a later sibling reference a named parallel branch result', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [
        {
          kind: 'parallel',
          id: 'checks',
          failurePolicy: 'collect_outcomes',
          branches: [{ id: 'lint', blocks: [textStep('run-lint', 'lint')] }],
        },
        textStep('report', 'report', {
          input: [{ kind: 'result', producer: { blockId: 'lint', scope: { kind: 'current' } } }],
        }),
      ],
    });
    expect(result.issues).toEqual([]);
  });

  it('requires evaluator continuation and permits declared decisions on ordinary steps', () => {
    const badEvaluator = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop',
        id: 'judge',
        repetition: {
          kind: 'evaluate',
          maxIterations: 2,
          history: 'none',
          evaluator: textStep('judge-step', 'decide', { result: { kind: 'text' } }),
        },
        body: [textStep('work', 'x')],
      }],
    });
    expect(codesOf(badEvaluator)).toContain('invalid_result_contract');

    const strayDecision = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', { result: { kind: 'decision', decisions: ['continue', 'done', 'stuck'] } })],
    });
    expect(strayDecision.valid).toBe(true);
    for (const decisions of [['done', 'stuck'], ['continue']]) {
      expect(codesOf(validateWorkflowDefinition({ defaults: { agentTarget: CLAUDE_AGENT_TARGET }, blocks: [{
        kind: 'loop', id: 'judge', body: [textStep('work', 'x')], repetition: {
          kind: 'evaluate', maxIterations: 2, history: 'none',
          evaluator: textStep('judge-step', 'decide', { result: { kind: 'decision', decisions } }),
        },
      }] }))).toContain('invalid_result_contract');
    }
  });

  it('rejects statically impossible repetition bounds', () => {
    const zeroCount = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop',
        id: 'each',
        repetition: { kind: 'count', count: { kind: 'literal', value: 0 } },
        body: [textStep('inner', 'x')],
      }],
    });
    expect(zeroCount.valid).toBe(true);
    expect(zeroCount.issues).toEqual([]);

    const notAList = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'loop',
        id: 'each',
        repetition: {
          kind: 'items',
          items: { kind: 'literal', value: 'nope' },
          execution: 'sequential',
          failurePolicy: 'fail_stop',
        },
        body: [textStep('inner', 'x')],
      }],
    });
    expect(codesOf(notAList)).toContain('invalid_repetition');
  });

  it('accepts a depth-1200 document below the stored envelope boundary stack-safely', () => {
    let nested: Record<string, unknown> = textStep('leaf', 'finish');
    for (let depth = 1_199; depth >= 0; depth -= 1) {
      nested = {
        kind: 'if',
        id: `gate_${depth}`,
        when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [nested],
        otherwise: [],
      };
    }
    const input = {
      kind: 'happier.workflow',
      version: 1,
      definition: {
        version: 1,
        defaults: { agentTarget: CLAUDE_AGENT_TARGET },
        blocks: [nested],
      },
    };
    const json = JSON.stringify(input);
    const encodedBytes = new TextEncoder().encode(json).byteLength;
    expect(encodedBytes).toBeGreaterThan(0);
    expect(encodedBytes).toBeLessThan(512 * 1024);

    let result: ReturnType<typeof parseWorkflowDocumentJsonIngressV1> | undefined;
    expect(() => { result = parseWorkflowDocumentJsonIngressV1(json); }).not.toThrow();
    expect(result?.ok).toBe(true);
    if (result?.ok !== true) throw new Error(`expected depth-1200 document to normalize: ${JSON.stringify(result)}`);
    expect(result.document.definition.blocks).toHaveLength(1);
    let current: unknown = result.document.definition.blocks[0];
    for (let depth = 0; depth < 1_200; depth += 1) {
      expect((current as { kind: string; id: string }).kind).toBe('if');
      expect((current as { id: string }).id).toBe(`gate_${depth}`);
      const thenBlocks = (current as { then: unknown[] }).then;
      expect(thenBlocks).toHaveLength(1);
      current = thenBlocks[0];
    }
    expect((current as { kind: string; id: string }).kind).toBe('step');
    expect((current as { id: string }).id).toBe('leaf');
  });

  it('rejects an ordering comparison between incompatible literals', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', {
        onlyWhen: {
          kind: 'compare',
          operator: 'gt',
          left: { kind: 'literal', value: 'text' },
          right: { kind: 'literal', value: 3 },
        },
      })],
    });
    expect(codesOf(result)).toContain('invalid_condition');
  });

  it('accepts an ordering comparison between homogeneous string literals', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', {
        onlyWhen: {
          kind: 'compare',
          operator: 'lt',
          left: { kind: 'literal', value: 'apple' },
          right: { kind: 'literal', value: 'banana' },
        },
      })],
    });
    expect(result.valid).toBe(true);
    expect(codesOf(result)).not.toContain('invalid_condition');
  });
});

describe('workflow declared inputs', () => {
  it('rejects a required input that also declares a default', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      inputs: [{ name: 'topic', valueType: 'string', required: true, default: 'x' }],
      blocks: ['Analyze'],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a default whose type does not match the declared value type', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      inputs: [{ name: 'count', valueType: 'number', required: false, default: 'ten' }],
      blocks: ['Analyze'],
    });
    expect(codesOf(result)).toContain('invalid_input');
  });

  it('preserves declaration order through normalization', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      inputs: [
        { name: 'zulu', valueType: 'string', required: true },
        { name: 'alpha', valueType: 'boolean', required: false, default: false },
      ],
      blocks: ['Analyze'],
    });
    expect((result.normalizedDefinition?.inputs ?? []).map((input) => input.name)).toEqual(['zulu', 'alpha']);
  });
});

describe('workflow authoring selection round trip', () => {
  it('rejects malformed and unknown-field MCP selections in executable definitions', () => {
    expect(WorkflowSessionAuthoringSelectionSchema.safeParse({
      mcpSelection: 'managed',
    }).success).toBe(false);
    expect(WorkflowSessionAuthoringSelectionSchema.safeParse({
      mcpSelection: [],
    }).success).toBe(false);
    expect(WorkflowSessionAuthoringSelectionSchema.safeParse({
      mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: [],
        forceExcludeServerIds: [],
        unexpectedPolicy: true,
      },
    }).success).toBe(false);
  });

  it('round-trips the exact authored MCP selection policy', () => {
    for (const selection of [
      {
        v: 1 as const,
        managedServersEnabled: true,
        forceIncludeServerIds: ['project-tools'],
        forceExcludeServerIds: ['global-tools'],
      },
      {
        v: 1 as const,
        managedServersEnabled: false,
        forceIncludeServerIds: ['explicit-tools'],
        forceExcludeServerIds: ['managed-tools'],
      },
    ]) {
      expect(WorkflowSessionAuthoringSelectionSchema.parse({
        mcpSelection: selection,
      })).toEqual({ mcpSelection: selection });
    }
  });

  it('distinguishes omission, explicit null and an override equal to the default', () => {
    const parsed = WorkflowSessionAuthoringSelectionSchema.parse({
      permissionMode: null,
      profileId: 'reviewer',
    });
    expect(Object.hasOwn(parsed, 'permissionMode')).toBe(true);
    expect(parsed.permissionMode).toBeNull();
    expect(Object.hasOwn(parsed, 'modelSelection')).toBe(false);
    expect(Object.hasOwn(parsed, 'agentTarget')).toBe(false);

    const equalOverride = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET, permissionMode: 'default' },
      blocks: [textStep('a', 'x', { execution: { permissionMode: 'default' } })],
    });
    expect(equalOverride.issues).toEqual([]);
    const step = equalOverride.normalizedDefinition?.blocks[0] as { execution?: Record<string, unknown> };
    expect(step.execution).toEqual({ permissionMode: 'default' });
  });

  it('round-trips the full canonical selection without collapsing structured values', () => {
    const execution = {
      agentTarget: CLAUDE_AGENT_TARGET,
      modelSelection: {
        v: 1 as const,
        ref: {
          agentTargetKey: 'agent:happier.agent.claude/claude',
          providerConnectionId: 'provider-1',
          modelId: 'claude-opus',
        },
        updatedAt: 41,
      },
      profileId: 'reviewer',
      permissionMode: 'read_only',
      acpSessionModeId: 'plan',
      sessionConfigOptionOverrides: {
        v: 1 as const,
        updatedAt: 43,
        overrides: {
          reasoning: { value: 'high', updatedAt: 42 },
        },
      },
      transcriptStorage: 'direct' as const,
      mcpSelection: { v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: ['a'], forceExcludeServerIds: [] },
      connectedServices: {
        v: 1 as const,
        bindingsByServiceId: {
          'happier.test.connected/service': { source: 'native' as const },
        },
      },
      terminal: { mode: 'tmux' as const, tmux: { sessionName: 'review', isolated: true } },
      windowsRemoteSessionLaunchMode: 'windows_terminal' as const,
      windowsRemoteSessionConsole: 'hidden' as const,
      windowsTerminalWindowName: 'review',
      runtimeDescriptorV1: null,
      conversation: { kind: 'from_step' as const, producer: { blockId: 'analyze', scope: { kind: 'current' as const } } },
      workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } },
    };
    const definition = {
      version: 1,
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('analyze', 'a'), textStep('implement', 'b', { execution })],
    };

    const result = validateWorkflowDefinition(definition);
    expect(result.issues).toEqual([]);
    const roundTripped = WorkflowDefinitionSchema.parse(
      JSON.parse(JSON.stringify(result.normalizedDefinition)),
    );
    expect((roundTripped.blocks[1] as { execution?: unknown }).execution).toEqual({
      ...execution,
      connectedServices: {
        ...execution.connectedServices,
        v: 2,
      },
    });
  });

  it('preserves inherited Session cwd and rejects only explicit worktree forks before Run admission', () => {
    const existingSession = { kind: 'existing_session' as const, sessionId: 'session-1', machineId: 'machine-1' };
    const newWorktree = { kind: 'new_worktree' as const, source: { kind: 'original' as const } };

    const inherited = validateWorkflowDefinition({
      version: 1,
      defaults: { agentTarget: CLAUDE_AGENT_TARGET, conversation: existingSession, workspace: newWorktree },
      blocks: [textStep('work', 'work')],
    });
    expect(inherited.valid).toBe(true);

    for (const definition of [
      {
        version: 1,
        defaults: { agentTarget: CLAUDE_AGENT_TARGET },
        blocks: [textStep('work', 'work', { execution: { conversation: existingSession, workspace: newWorktree } })],
      },
      {
        version: 1,
        defaults: { agentTarget: CLAUDE_AGENT_TARGET, conversation: existingSession, workspace: newWorktree },
        blocks: [textStep('work', 'work', { execution: { workspace: newWorktree } })],
      },
      {
        version: 1,
        defaults: { agentTarget: CLAUDE_AGENT_TARGET },
        blocks: [textStep('work', 'work', { execution: { conversation: { kind: 'origin_session' }, workspace: newWorktree } })],
      },
    ]) {
      const result = validateWorkflowDefinition(definition);
      expect(result.valid).toBe(false);
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: 'conversation_workspace_mismatch',
        path: '/blocks/0/execution/workspace',
        blockId: 'work',
      }));
    }
  });

  it('preserves canonical Connected Service binding choices without admitting credential material', () => {
    const qualifiedServiceId = 'happier.test.connected/service';
    const bindings = {
      v: 1 as const,
      bindingsByServiceId: {
        [qualifiedServiceId]: { source: 'native' as const },
        'happier.test.connected/profile': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'reviewer:primary',
        },
        'happier.test.connected/group': {
          source: 'connected' as const,
          selection: 'group' as const,
          groupId: 'reviewers.primary',
          profileId: 'reviewer:fallback',
        },
      },
    };
    const accepted = WorkflowSessionAuthoringSelectionSchema.parse({ connectedServices: bindings });
    expect(accepted.connectedServices).toEqual({ ...bindings, v: 2 });

    expect(WorkflowSessionAuthoringSelectionSchema.safeParse({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          [qualifiedServiceId]: {
            source: 'connected',
            profileId: 'reviewer:primary',
            credential: 'must-not-enter-portable-definition-json',
          },
        },
      },
    }).success).toBe(false);
  });

  it('rejects environment and Machine placement while accepting per-leaf execution classes', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', { execution: { environmentVariables: { TOKEN: 'secret' } } })],
    });
    expect(codesOf(result)).toContain('unknown_field');

    const machine = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET, executionTarget: { kind: 'machine', machineId: 'm1' } },
      blocks: ['Analyze'],
    });
    expect(codesOf(machine)).toContain('invalid_input');

    const runtimeKind = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [textStep('a', 'x', { execution: { executionTarget: { kind: 'detached_run' } } })],
    });
    expect(runtimeKind.valid).toBe(true);
  });

  it('blocks a staged-media attachment with the exact repairable reason', () => {
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'step',
        id: 'a',
        document: {
          text: 'look at this',
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
      }],
    });
    expect(result.valid).toBe(false);
    expect(codesOf(result)).toEqual(['unsupported_persisted_attachment']);
    expect(result.issues[0]?.path).toContain('/attachments/0/content');
  });

  it('preserves canonical composer references and contentless attachments', () => {
    const attachment = {
      v: 1,
      instanceId: 'attachment-1',
      attachment: { pluginId: 'happier.media', localId: 'image' },
      key: 'image-1',
      value: { mediaId: 'media-1' },
      presentation: { label: 'Screenshot', typeLabel: 'Image' },
    };
    const reference = { kind: 'happier.file', ref: 'file:src/index.ts', token: '@src/index.ts', label: 'index.ts' };
    const result = validateWorkflowDefinition({
      defaults: { agentTarget: CLAUDE_AGENT_TARGET },
      blocks: [{
        kind: 'step',
        id: 'a',
        document: { text: 'look at @src/index.ts', references: [reference], attachments: [attachment] },
      }],
    });
    expect(result.issues).toEqual([]);
    const document = (result.normalizedDefinition?.blocks[0] as { document: { references: unknown[]; attachments: unknown[] } }).document;
    expect(document.references).toEqual([reference]);
    expect(document.attachments).toEqual([attachment]);
  });
});

describe('workflow validation result contract', () => {
  it('returns the normalized definition even when target diagnostics are unavailable', () => {
    const result = validateWorkflowDefinition(
      { defaults: { agentTarget: CLAUDE_AGENT_TARGET }, blocks: ['Analyze'] },
      { targetValidation: 'unavailable' },
    );
    expect(result.targetValidation).toBe('unavailable');
    expect(result.normalizedDefinition).toBeDefined();
    expect(result.valid).toBe(true);
  });

  it('surfaces caller-supplied target issues without withholding the definition', () => {
    const result = validateWorkflowDefinition(
      { defaults: { agentTarget: CLAUDE_AGENT_TARGET }, blocks: ['Analyze'] },
      {
        targetValidation: 'checked',
        targetIssues: [{
          code: 'target_unavailable',
          path: '/defaults/agentTarget',
          message: 'That Agent is not installed on the selected machine.',
          severity: 'error',
        }],
      },
    );
    expect(result.valid).toBe(false);
    expect(result.normalizedDefinition).toBeDefined();
  });

  it('does not reject a large valid definition by an invented quota', () => {
    const blocks = Array.from({ length: 500 }, (_, index) => `Review file number ${index}`);
    const result = validateWorkflowDefinition({ defaults: { agentTarget: CLAUDE_AGENT_TARGET }, blocks });
    expect(result.valid).toBe(true);
    expect(result.normalizedDefinition?.blocks).toHaveLength(500);
  });

  it('rejects an empty root block list because an automation with no action is not a workflow', () => {
    const result = validateWorkflowDefinition({ defaults: { agentTarget: CLAUDE_AGENT_TARGET }, blocks: [] });
    expect(result.valid).toBe(false);
  });

  it('normalizes the ingress dialect through one entry point', () => {
    const outcome = normalizeWorkflowIngress(
      { blocks: ['Analyze'] },
      { agentTarget: CLAUDE_AGENT_TARGET },
    );
    expect(outcome.kind).toBe('parsed');
  });

  describe('portable runtime selection', () => {
    const portableCodex = { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } };

    it('keeps portable Agent runtime intent in an authored selection', () => {
      for (const portable of [
        portableCodex,
        { v: 1, agentId: 'opencode', agent: { backendMode: 'server' } },
        {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            home: 'connectedService',
            connectedServiceId: 'service-1',
            connectedServiceProfileId: 'profile-1',
            connectedServiceGroupId: 'group-1',
          },
        },
      ]) {
        const parsed = WorkflowSessionAuthoringSelectionSchema.safeParse({ runtimeDescriptorV1: portable });
        expect(parsed.success, JSON.stringify(portable)).toBe(true);
        if (parsed.success) expect(parsed.data.runtimeDescriptorV1).toEqual(portable);
      }
      expect(WorkflowSessionAuthoringSelectionSchema.safeParse({ runtimeDescriptorV1: null }).success).toBe(true);
    });

    it('rejects runtime identity, host reachability, credentials and unknown descriptor fields', () => {
      const nonportable: ReadonlyArray<readonly [string, unknown]> = [
        ['codex provider session', { v: 1, agentId: 'codex', agent: { backendMode: 'acp', providerSessionId: 'conversation-1' } }],
        ['codex home path', { v: 1, agentId: 'codex', agent: { backendMode: 'acp', homePath: '/Users/alice/.codex' } }],
        ['opencode server url', { v: 1, agentId: 'opencode', agent: { backendMode: 'server', serverBaseUrl: 'http://127.0.0.1:4096' } }],
        ['opencode provider session', { v: 1, agentId: 'opencode', agent: { backendMode: 'server', providerSessionId: 'conversation-1' } }],
        ['agent extra runtime handle', {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'acp',
            agentExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: { providerSessionId: 'conversation-1', homePath: '/Users/alice/.codex' },
            },
          },
        }],
        ['environment bag', { v: 1, agentId: 'codex', agent: { backendMode: 'acp', environmentVariables: { TOKEN: 'secret' } } }],
        ['password field', { v: 1, agentId: 'codex', agent: { backendMode: 'acp', password: 'secret' } }],
        ['unknown nested field', { v: 1, agentId: 'codex', agent: { backendMode: 'acp', unexpected: { nested: true } } }],
        ['unknown envelope field', { v: 1, agentId: 'codex', agent: { backendMode: 'acp' }, machineHomePath: '/Users/alice' }],
      ];
      for (const [label, descriptor] of nonportable) {
        expect(
          WorkflowSessionAuthoringSelectionSchema.safeParse({ runtimeDescriptorV1: descriptor }).success,
          label,
        ).toBe(false);
      }
    });

    it('round-trips a portable selection through the canonical document without disclosing runtime identity', () => {
      const definition = WorkflowDefinitionSchema.parse(validateWorkflowDefinition({
        defaults: { agentTarget: CLAUDE_AGENT_TARGET, runtimeDescriptorV1: portableCodex },
        blocks: ['Analyze'],
      }).normalizedDefinition);
      const json = serializeWorkflowDocumentJsonV1({ kind: 'happier.workflow', version: 1, definition });
      expect(json).not.toContain('providerSessionId');
      expect(json).not.toContain('homePath');
      expect(parseWorkflowDocumentJsonV1(json).definition.defaults.runtimeDescriptorV1).toEqual(portableCodex);
    });

    it('refuses to parse an imported document whose descriptor carries nonportable runtime identity', () => {
      const definition = WorkflowDefinitionSchema.parse(validateWorkflowDefinition({
        defaults: { agentTarget: CLAUDE_AGENT_TARGET, runtimeDescriptorV1: portableCodex },
        blocks: ['Analyze'],
      }).normalizedDefinition);
      const tampered = JSON.parse(serializeWorkflowDocumentJsonV1({
        kind: 'happier.workflow', version: 1, definition,
      })) as { definition: { defaults: { runtimeDescriptorV1: Record<string, unknown> } } };
      tampered.definition.defaults.runtimeDescriptorV1 = {
        v: 1, agentId: 'codex', agent: { backendMode: 'acp', providerSessionId: 'conversation-1' },
      };
      expect(() => parseWorkflowDocumentJsonV1(JSON.stringify(tampered)))
        .toThrowError(expect.objectContaining({ code: 'workflow_document_invalid' }));
    });

    it('reports the exact validation path for a nonportable authored descriptor', () => {
      const result = validateWorkflowDefinition({
        defaults: {
          agentTarget: CLAUDE_AGENT_TARGET,
          runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp', homePath: '/Users/alice/.codex' } },
        },
        blocks: ['Analyze'],
      });
      expect(result.valid).toBe(false);
      expect(result.issues.some((entry) => entry.path.startsWith('/defaults/runtimeDescriptorV1'))).toBe(true);
    });
  });
});
