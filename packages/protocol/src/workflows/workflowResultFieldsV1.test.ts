import { describe, expect, it } from 'vitest';

import { validateExecutionRunProfileResult } from '../execution/runs/resultContract.js';
import { WORKFLOW_STARTER_EXAMPLES_V1 } from './builtins/examples.js';
import {
  applyWorkflowDefinitionEditsV1,
  listWorkflowResultFieldConsumers,
  renameWorkflowResultField,
  WorkflowDefinitionEditOpV1Schema,
  walkWorkflowBlocks,
  type WorkflowDefinitionDraftV1,
} from './workflowDefinitionEditV1.js';
import {
  buildWorkflowResultFieldsContract,
  projectWorkflowResultFields,
  type WorkflowResultField,
} from './workflowResultFieldsV1.js';
import { WorkflowDraftEditInputV1Schema } from '../actions/workflowAuthoringAction.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import type { WorkflowBlock, WorkflowResultContract } from './workflowV1.js';
import { readWorkflowValuePathV1 } from './workflowReferenceV1.js';
import { WorkflowBlockSchema } from './workflowV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import type { JsonValue } from '../json/strictJsonValue.js';

const FIELDS: readonly WorkflowResultField[] = [
  {
    name: 'fixed',
    type: 'boolean',
    required: true,
    description: 'Whether the fix holds',
  },
  { name: 'notes', type: 'text', required: false },
  {
    name: 'severity',
    type: 'choice',
    required: true,
    choices: ['low', 'high'],
  },
  { name: 'confidence', type: 'number', required: false },
  { name: 'files', type: 'list', required: false, itemType: 'text' },
];

describe('named result fields (04 §6.1)', () => {
  it('preserves text length constraints when authoring and review share named fields', () => {
    const contract: WorkflowResultContract = { kind: 'json', schema: { type: 'object', properties: {
      summary: { type: 'string', minLength: 1, maxLength: 200 },
    }, required: ['summary'], additionalProperties: false } };
    const projection = projectWorkflowResultFields(contract);
    expect(projection.kind).toBe('fields');
    if (projection.kind !== 'fields') throw new Error('Expected named fields');
    expect(buildWorkflowResultFieldsContract(projection.fields)).toEqual(contract);
    const changedType = buildWorkflowResultFieldsContract(projection.fields.map(field => ({ ...field, type: 'list', itemType: 'text' })));
    expect(changedType.schema.properties?.summary).toEqual({ type: 'array', items: { type: 'string' } });
  });
  it('round-trips every field type through the schema runtime validation reads', () => {
    const contract = buildWorkflowResultFieldsContract(FIELDS);
    expect(projectWorkflowResultFields(contract)).toEqual({
      kind: 'fields',
      fields: FIELDS,
      closed: true,
    });
    // The projection writes the subset runtime validation enforces: types, required, choices, closed object.
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'high', files: ['a.ts'] },
        contract,
      ).ok,
    ).toBe(true);
    expect(
      validateExecutionRunProfileResult(
        { fixed: 'yes', severity: 'high' },
        contract,
      ).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult({ fixed: true }, contract).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'medium' },
        contract,
      ).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'low', extra: 1 },
        contract,
      ).ok,
    ).toBe(false);
    expect(
      validateExecutionRunProfileResult(
        { fixed: true, severity: 'low', files: [1] },
        contract,
      ).ok,
    ).toBe(false);
  });

  it('keeps an open loaded contract open and preserves titles exactly', () => {
    const open: WorkflowResultContract = {
      kind: 'json',
      schema: {
        type: 'object',
        properties: { verdict: { type: 'string', title: 'Verdict' } },
      },
    };
    const projection = projectWorkflowResultFields(open);
    expect(projection).toEqual({
      kind: 'fields',
      closed: false,
      fields: [
        { name: 'verdict', type: 'text', required: false, title: 'Verdict' },
      ],
    });
    if (projection.kind !== 'fields') throw new Error('unreachable');
    expect(
      buildWorkflowResultFieldsContract(projection.fields, {
        closed: projection.closed,
      }),
    ).toEqual(open);
  });

  it('projects every shipped example contract exactly, so their fields are editable without rewriting', () => {
    for (const example of WORKFLOW_STARTER_EXAMPLES_V1) {
      for (const block of walkWorkflowBlocks(example.definition.blocks)) {
        if (
          (block.kind !== 'step' && block.kind !== 'wait') ||
          block.result?.kind !== 'json'
        )
          continue;
        const projection = projectWorkflowResultFields(block.result);
        expect(projection.kind).toBe('fields');
        if (projection.kind !== 'fields') continue;
        expect(
          buildWorkflowResultFieldsContract(projection.fields, {
            closed: projection.closed,
          }),
        ).toEqual(block.result);
      }
    }
  });

  it.each<[string, WorkflowResultContract]>([
    [
      'integer',
      {
        kind: 'json',
        schema: { type: 'object', properties: { n: { type: 'integer' } } },
      },
    ],
    [
      'nested object',
      {
        kind: 'json',
        schema: { type: 'object', properties: { a: { type: 'object' } } },
      },
    ],
    [
      'bounds',
      {
        kind: 'json',
        schema: {
          type: 'object',
          properties: { a: { type: 'number', maximum: 3 } },
        },
      },
    ],
    [
      'non-object root',
      { kind: 'json', schema: { type: 'array', items: { type: 'string' } } },
    ],
    [
      'composition',
      {
        kind: 'json',
        schema: { type: 'object', anyOf: [{ required: ['a'] }] },
      },
    ],
    [
      'typed additional properties',
      {
        kind: 'json',
        schema: { type: 'object', additionalProperties: { type: 'string' } },
      },
    ],
    [
      'list of objects',
      {
        kind: 'json',
        schema: {
          type: 'object',
          properties: { a: { type: 'array', items: { type: 'object' } } },
        },
      },
    ],
    [
      'required unknown name',
      {
        kind: 'json',
        schema: { type: 'object', properties: {}, required: ['ghost'] },
      },
    ],
  ])('leaves an advanced %s schema to its owner', (_label, contract) => {
    expect(projectWorkflowResultFields(contract)).toEqual({ kind: 'advanced' });
  });
});

/** The canonical validator over a draft; asserts it parsed, so an empty issue filter is never vacuous. */
function validateDraft(draft: WorkflowDefinitionDraftV1) {
  const { name: _name, ...definition } = draft;
  const result = validateWorkflowDefinition({ ...definition, version: 1 });
  expect(result.normalizedDefinition).toBeDefined();
  return result;
}

function releaseDraft(): WorkflowDefinitionDraftV1 {
  const check = {
    kind: 'result' as const,
    producer: { blockId: 'check', scope: { kind: 'current' as const } },
    path: ['fixed'],
  };
  return {
    name: 'Release',
    inputs: [],
    defaults: {},
    blocks: [
      {
        kind: 'step',
        id: 'check',
        name: 'Check the fix',
        document: { text: 'Check', references: [], attachments: [] },
        input: [],
        result: buildWorkflowResultFieldsContract(FIELDS),
      },
      {
        kind: 'if',
        id: 'gate',
        when: {
          kind: 'compare',
          operator: 'eq',
          left: check,
          right: { kind: 'literal', value: false },
        },
        then: [
          {
            kind: 'step',
            id: 'reopen',
            document: { text: 'Reopen', references: [], attachments: [] },
            input: [
              {
                ...check,
                producer: {
                  blockId: 'check',
                  scope: { kind: 'outer', levels: 1 },
                },
                path: ['notes'],
              },
              {
                ...check,
                producer: {
                  blockId: 'check',
                  scope: { kind: 'outer', levels: 1 },
                },
                path: ['fixed'],
              },
            ],
          },
        ],
        otherwise: [],
      },
    ],
    finalOutput: { ...check, path: ['fixed'] },
  } as WorkflowDefinitionDraftV1;
}

describe('result field consumers and rename-with-consumers', () => {
  const check: WorkflowBlock = {
    kind: 'wait', id: 'check', document: { text: 'Check', references: [], attachments: [] },
    result: buildWorkflowResultFieldsContract([{ name: 'fixed', type: 'boolean', required: true }]),
  };
  const count = { kind: 'count' as const, count: { kind: 'literal' as const, value: 1 } };

  it.each([
    { label: 'count index', container: { kind: 'loop', id: 'group', repetition: count, body: [check] }, path: [0, 'check', 'fixed'], output: [{ check: { passed: true } }] },
    { label: 'last iteration', container: { kind: 'loop', id: 'group', repetition: count, body: [check] }, path: ['last', 'check', 'fixed'], output: [{ check: { passed: true } }] },
    { label: 'item loop', container: { kind: 'loop', id: 'group', repetition: { kind: 'items', items: { kind: 'literal', value: ['a'] }, execution: 'sequential', failurePolicy: 'fail_stop' }, body: [check] }, path: [0, 'results', 'check', 'fixed'], output: [{ index: 0, status: 'completed', results: { check: { passed: true } } }] },
    { label: 'parallel item loop', container: { kind: 'loop', id: 'group', repetition: { kind: 'items', items: { kind: 'literal', value: ['a'] }, execution: 'parallel', failurePolicy: 'fail_stop' }, body: [check] }, path: [0, 'results', 'check', 'fixed'], output: [{ index: 0, status: 'completed', results: { check: { passed: true } } }] },
    { label: 'nested loops', container: { kind: 'loop', id: 'group', repetition: count, body: [{ kind: 'loop', id: 'inner', repetition: count, body: [check] }] }, path: [0, 'inner', 0, 'check', 'fixed'], output: [{ inner: [{ check: { passed: true } }] }] },
    { label: 'parallel branch', container: { kind: 'parallel', id: 'group', failurePolicy: 'fail_stop', branches: [{ id: 'branch', blocks: [check] }] }, path: [0, 'results', 'check', 'fixed'], output: [{ branchId: 'branch', status: 'completed', results: { check: { passed: true } } }] },
    { label: 'conditional', container: { kind: 'if', id: 'group', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [check], otherwise: [] }, path: ['check', 'fixed'], output: { check: { passed: true } } },
  ] satisfies readonly { label: string; container: WorkflowBlock; path: (string | number)[]; output: JsonValue }[])(
    'repairs $label consumers and final output through the Action rename', ({ container, path, output }) => {
      const reference = { kind: 'result' as const, producer: { blockId: 'group', scope: { kind: 'current' as const } }, path };
      const untouched = { kind: 'literal' as const, value: { check: { fixed: true } } };
      const draft: WorkflowDefinitionDraftV1 = {
        name: 'Release', defaults: {}, inputs: [], blocks: [container, {
          kind: 'wait', id: 'reader', document: { text: 'Read', references: [], attachments: [] }, result: { kind: 'text' },
          onlyWhen: { kind: 'all', conditions: [{ kind: 'exists', value: reference }, { kind: 'exists', value: untouched }] },
        }], finalOutput: reference,
      };
      expect(validateDraft(draft).valid).toBe(true);
      expect(listWorkflowResultFieldConsumers(draft, 'check', 'fixed')).toEqual([{ blockId: 'reader' }, { finalOutput: true }]);
      const applied = applyWorkflowDefinitionEditsV1(draft, [WorkflowDefinitionEditOpV1Schema.parse({
        kind: 'rename_result_field', blockId: 'check', from: 'fixed', to: 'passed',
      })]);
      if (!applied.ok) throw new Error('expected rename');
      const repairedPath = [...path.slice(0, -1), 'passed'];
      expect(applied.draft.finalOutput?.path).toEqual(repairedPath);
      expect(applied.draft.blocks[1]).toMatchObject({ onlyWhen: { conditions: [{ value: { path: repairedPath } }, { value: untouched }] } });
      expect(readWorkflowValuePathV1(output, repairedPath)).toBe(true);
      expect(validateDraft(applied.draft).valid).toBe(true);
      expect(listWorkflowResultFieldConsumers(applied.draft, 'check', 'fixed')).toEqual([]);
      expect(listWorkflowResultFieldConsumers(applied.draft, 'check', 'passed')).toHaveLength(2);
      const withoutField = renameWorkflowResultField(applied.draft, 'check', 'passed', 'gone');
      // The old path now refers to a removed field, so the same location projection must diagnose it.
      expect(validateDraft({ ...withoutField, finalOutput: { ...reference, path: repairedPath } }).issues)
        .toContainEqual(expect.objectContaining({ code: 'missing_reference', path: `/finalOutput/path/${path.length - 1}` }));
    },
  );

  it('refuses the unsupported result name before parsing or applying a rename', () => {
    const draft = releaseDraft();
    const before = JSON.stringify(draft);
    const op = { kind: 'rename_result_field' as const, blockId: 'check', from: 'fixed', to: '__proto__' };
    expect(WorkflowDefinitionEditOpV1Schema.safeParse(op).success).toBe(false);
    expect(applyWorkflowDefinitionEditsV1(draft, [op])).toEqual({ ok: false, issue: { opIndex: 0, code: 'invalid_target' } });
    expect(renameWorkflowResultField(draft, 'check', 'fixed', '__proto__')).toBe(draft);
    expect(JSON.stringify(draft)).toBe(before);
  });

  it.each([false, true])('refuses replacement with an unsupported result name before the schema parser drops it (required=%s)', (required) => {
    const draft = releaseDraft();
    const before = JSON.stringify(draft);
    const block: WorkflowBlock = { ...check, result: buildWorkflowResultFieldsContract([
      { name: '__proto__', type: 'boolean', required },
    ]) };
    expect(Object.hasOwn(block.result!.kind === 'json' ? block.result.schema.properties! : {}, '__proto__')).toBe(true);
    const op = { kind: 'replace_block' as const, blockId: 'check', block };
    expect(WorkflowDefinitionEditOpV1Schema.safeParse(op).success).toBe(false);
    expect(applyWorkflowDefinitionEditsV1(draft, [op])).toEqual({ ok: false, issue: { opIndex: 0, code: 'invalid_target' } });
    expect(JSON.stringify(draft)).toBe(before);
    // Stored reads remain tolerant; the named-field editor must not rewrite this contract.
    expect(createStoredReadSchema(WorkflowBlockSchema).safeParse(block).success).toBe(true);
    expect(projectWorkflowResultFields(block.result)).toEqual({ kind: 'advanced' });
    expect(JSON.stringify(draft)).toBe(before);
  });

  it('preserves accepted own-property field names through parsed rename, JSON and imported projection', () => {
    const draft = releaseDraft();
    const applied = applyWorkflowDefinitionEditsV1(draft, [WorkflowDefinitionEditOpV1Schema.parse({
      kind: 'rename_result_field', blockId: 'check', from: 'fixed', to: 'constructor',
    })]);
    if (!applied.ok) throw new Error('expected rename');
    const block = applied.draft.blocks[0];
    if (block?.kind !== 'step' || block.result?.kind !== 'json') throw new Error('expected JSON result');
    expect(Object.hasOwn(block.result.schema.properties ?? {}, 'constructor')).toBe(true);
    const serialized = JSON.parse(JSON.stringify(block.result));
    expect(serialized.schema.properties.constructor).toMatchObject({ type: 'boolean' });
    expect(projectWorkflowResultFields(serialized)).toMatchObject({ kind: 'fields', fields: [expect.objectContaining({ name: 'constructor', required: true }), ...FIELDS.slice(1)] });
    expect(applied.draft.finalOutput?.path).toEqual(['constructor']);
    const imported: WorkflowResultContract = { kind: 'json', schema: { type: 'object', properties: Object.fromEntries([
      ['whole', { type: 'string' as const }], ['constructor', { type: 'boolean' as const }],
    ]) } };
    const projection = projectWorkflowResultFields(imported);
    if (projection.kind !== 'fields') throw new Error('expected fields');
    expect(JSON.stringify(buildWorkflowResultFieldsContract(projection.fields, { closed: projection.closed }))).toBe(JSON.stringify(imported));
  });

  it('diagnoses a removed field in trailing counts after checking loop scope, while retaining open and whole results', () => {
    const makeDraft = (result: WorkflowResultContract, path: (string | number)[] = ['fixed']): WorkflowDefinitionDraftV1 => ({
      name: 'Converge', inputs: [], defaults: {}, blocks: [{ kind: 'loop', id: 'loop', repetition: count, body: [
        { ...check, result },
        { kind: 'wait', id: 'reader', document: { text: 'Read', references: [], attachments: [] }, result: { kind: 'text' },
          onlyWhen: { kind: 'compare', operator: 'gte', left: { kind: 'loop_trailing_count', producer: { blockId: 'check', scope: { kind: 'current' } }, path, equals: true }, right: { kind: 'literal', value: 1 } } },
      ] }],
    });
    const contract = buildWorkflowResultFieldsContract([{ name: 'fixed', type: 'boolean', required: true }]);
    expect(validateDraft(makeDraft(contract)).valid).toBe(true);
    const empty = buildWorkflowResultFieldsContract([]);
    expect(validateDraft(makeDraft(empty)).issues).toContainEqual(expect.objectContaining({
      code: 'missing_reference', blockId: 'reader', path: '/blocks/0/body/1/onlyWhen/path/0',
    }));
    expect(validateDraft(makeDraft(empty, [])).valid).toBe(true);
    expect(validateDraft(makeDraft(buildWorkflowResultFieldsContract([], { closed: false }))).valid).toBe(true);
    expect(validateDraft(makeDraft({ kind: 'json', schema: { type: 'object', additionalProperties: { type: 'boolean' } } })).valid).toBe(true);
    const renamed = renameWorkflowResultField(makeDraft(contract), 'check', 'fixed', 'passed');
    expect(validateDraft(renamed).valid).toBe(true);
    expect(listWorkflowResultFieldConsumers(renamed, 'check', 'passed')).toEqual([{ blockId: 'reader' }]);
  });

  it('lists every block and the final output that read a field', () => {
    const draft = releaseDraft();
    expect(listWorkflowResultFieldConsumers(draft, 'check', 'fixed')).toEqual([
      { blockId: 'gate' },
      { blockId: 'reopen' },
      { finalOutput: true },
    ]);
    expect(listWorkflowResultFieldConsumers(draft, 'check', 'notes')).toEqual([
      { blockId: 'reopen' },
    ]);
    expect(
      listWorkflowResultFieldConsumers(draft, 'check', 'severity'),
    ).toEqual([]);
  });

  it('renames the field and every consumer in one edit, through the shared Action grammar', () => {
    const draft = releaseDraft();
    const renamed = renameWorkflowResultField(
      draft,
      'check',
      'fixed',
      'passed',
    );
    const viaAction = applyWorkflowDefinitionEditsV1(draft, [
      {
        kind: 'rename_result_field',
        blockId: 'check',
        from: 'fixed',
        to: 'passed',
      },
    ]);
    expect(viaAction).toMatchObject({ ok: true, draft: renamed });
    expect(listWorkflowResultFieldConsumers(renamed, 'check', 'fixed')).toEqual(
      [],
    );
    expect(
      listWorkflowResultFieldConsumers(renamed, 'check', 'passed'),
    ).toHaveLength(3);
    const producer = renamed.blocks[0]!;
    expect(
      producer.kind === 'step'
        ? projectWorkflowResultFields(producer.result)
        : null,
    ).toMatchObject({
      kind: 'fields',
      fields: [
        { name: 'passed', type: 'boolean', required: true },
        { name: 'notes' },
        { name: 'severity' },
        { name: 'confidence' },
        { name: 'files' },
      ],
    });
    // The untouched consumer of another field keeps its identity.
    expect(listWorkflowResultFieldConsumers(renamed, 'check', 'notes')).toEqual(
      [{ blockId: 'reopen' }],
    );
    expect(
      validateDraft(renamed).issues.filter(
        (entry) => entry.code === 'missing_reference',
      ),
    ).toEqual([]);
  });

  it('lets an agent author fields and rename one through workflow.authoring.draft.edit', () => {
    const draft = releaseDraft();
    const producer = draft.blocks[0]!;
    const input = WorkflowDraftEditInputV1Schema.parse({
      scope: { serverId: 'home-a', accountId: 'account-a' },
      draftId: 'draft-a',
      expectedDraftRevision: 0,
      ops: [
        {
          kind: 'replace_block',
          blockId: 'check',
          block: {
            ...producer,
            result: buildWorkflowResultFieldsContract([
              ...FIELDS,
              { name: 'risk', type: 'choice', required: false, choices: ['low', 'high'] },
            ]),
          },
        },
        { kind: 'rename_result_field', blockId: 'check', from: 'fixed', to: 'passed' },
      ],
    });
    const applied = applyWorkflowDefinitionEditsV1(draft, input.ops ?? []);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const block = applied.draft.blocks[0]!;
    const projection = block.kind === 'step' ? projectWorkflowResultFields(block.result) : null;
    expect(projection).toMatchObject({ kind: 'fields' });
    expect(projection?.kind === 'fields' ? projection.fields.map((field) => field.name) : []).toEqual(
      ['passed', 'notes', 'severity', 'confidence', 'files', 'risk'],
    );
    expect(listWorkflowResultFieldConsumers(applied.draft, 'check', 'passed')).toHaveLength(3);
  });

  it('refuses a rename onto an existing field or of an absent one', () => {
    const draft = releaseDraft();
    expect(renameWorkflowResultField(draft, 'check', 'fixed', 'notes')).toBe(
      draft,
    );
    expect(renameWorkflowResultField(draft, 'check', 'ghost', 'other')).toBe(
      draft,
    );
    expect(
      applyWorkflowDefinitionEditsV1(draft, [
        {
          kind: 'rename_result_field',
          blockId: 'check',
          from: 'fixed',
          to: 'notes',
        },
      ]),
    ).toEqual({ ok: false, issue: { opIndex: 0, code: 'invalid_target' } });
  });

  it('flags a reference to a field a closed result no longer declares, so removal is repairable', () => {
    const draft = releaseDraft();
    const producer = draft.blocks[0]!;
    if (producer.kind !== 'step') throw new Error('unreachable');
    const removed: WorkflowDefinitionDraftV1 = {
      ...draft,
      blocks: [
        {
          ...producer,
          result: buildWorkflowResultFieldsContract(
            FIELDS.filter((field) => field.name !== 'notes'),
          ),
        },
        draft.blocks[1]!,
      ],
    };
    const issues = validateDraft(removed).issues.filter(
      (entry) => entry.code === 'missing_reference',
    );
    expect(issues).toEqual([
      expect.objectContaining({
        blockId: 'reopen',
        path: expect.stringMatching(/input\/0\/path\/0$/u),
      }),
    ]);
    // An open contract declares no closed set: other names stay valid.
    const open: WorkflowDefinitionDraftV1 = {
      ...removed,
      blocks: [
        {
          ...producer,
          result: buildWorkflowResultFieldsContract(
            FIELDS.filter((field) => field.name !== 'notes'),
            { closed: false },
          ),
        },
        draft.blocks[1]!,
      ],
    };
    expect(
      validateDraft(open).issues.filter(
        (entry) => entry.code === 'missing_reference',
      ),
    ).toEqual([]);
  });
});
