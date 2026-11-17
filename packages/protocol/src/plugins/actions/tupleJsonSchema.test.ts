import { describe, expect, it } from 'vitest';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from '../contributions/jsonSchema.js';
import { resolveDeclaredInputLeaves } from './inputSchemaTraversal.js';
import { compilePluginJsonSchema, createPluginJsonSchemaZodValueAdapter, normalizePluginJsonSchema } from './jsonSchemaValidation.js';
import { PluginAccountCollectionContributionV1Schema, isPluginCollectionSchemaWideningV1, normalizePluginAccountCollectionContractV1 } from '../data/collectionsV1.js';
import { areCollectionSchemaLayoutsEquivalent } from '../data/collectionSchemaEquivalence.js';
import { sameWorkflowResultFieldOrderV1 } from '../../workflows/workflowAuthoringEqualityV1.js';
import { WorkflowBlockSchema } from '../../workflows/workflowV1.js';
import type { PluginJsonSchemaV2 } from '../contributions/jsonSchema.js';

describe('draft-07 tuple schemas', () => {
  it('compares referenced tuple members and typed tails without losing positional constraints', () => {
    const item: PluginJsonSchemaV2 = { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false };
    const inline: PluginJsonSchemaV2 = { type: 'array', items: [item, { type: 'number' }], additionalItems: item };
    const referenced: PluginJsonSchemaV2 = { type: 'array', items: [{ $ref: '#/$defs/item' }, { type: 'number' }],
      additionalItems: { $ref: '#/$defs/item' }, $defs: { item } };
    expect(areCollectionSchemaLayoutsEquivalent(inline, referenced)).toBe(true);
    expect(areCollectionSchemaLayoutsEquivalent(inline, { ...referenced, items: [{ type: 'number' }, { $ref: '#/$defs/item' }] })).toBe(false);
    expect(areCollectionSchemaLayoutsEquivalent(inline, { ...referenced, additionalItems: { type: 'boolean' } })).toBe(false);
  });

  it('preserves visible result-field order inside tuple members and typed tails', () => {
    const ordered: PluginJsonSchemaV2 = { type: 'object', properties: { first: { type: 'string' }, second: { type: 'number' } }, additionalProperties: false };
    const reversed: PluginJsonSchemaV2 = { ...ordered, properties: { second: { type: 'number' }, first: { type: 'string' } } };
    const block = (member: PluginJsonSchemaV2, rest: PluginJsonSchemaV2) => WorkflowBlockSchema.parse({
      kind: 'step', id: 'answer', document: { text: 'Answer', references: [], attachments: [] },
      result: { kind: 'json', schema: { type: 'array', items: [member], additionalItems: rest } },
    });
    const before = [block(ordered, ordered)];
    expect(sameWorkflowResultFieldOrderV1(before, [block(ordered, ordered)])).toBe(true);
    expect(sameWorkflowResultFieldOrderV1(before, [block(reversed, ordered)])).toBe(false);
    expect(sameWorkflowResultFieldOrderV1(before, [block(ordered, reversed)])).toBe(false);
  });

  it('keeps draft-07 omitted, closed and typed additional-item semantics', () => {
    const items = [{ type: 'string' }, { type: 'number' }];
    const open = compilePluginJsonSchema({ type: 'array', items });
    const closed = compilePluginJsonSchema({ type: 'array', items, additionalItems: false });
    const rest = compilePluginJsonSchema({ type: 'array', items, additionalItems: { type: 'boolean' } });
    expect(open(['first', 2, 'extra'])).toBe(true);
    expect(closed(['first', 2, 'extra'])).toBe(false);
    expect(rest(['first', 2, true])).toBe(true);
    expect(rest(['first', 2, 'extra'])).toBe(false);
    // Prefix declarations alone do not require every tuple position.
    expect(closed(['first'])).toBe(true);
    expect(closed([2, 'first'])).toBe(false);
    const empty = compilePluginJsonSchema({ type: 'array', items: [], additionalItems: false });
    expect(empty([])).toBe(true);
    expect(empty([1])).toBe(false);
  });

  it('applies stored-read projection and recursive closure at each tuple position and typed rest', () => {
    const item = { type: 'object' as const, properties: { name: { type: 'string' as const } }, required: ['name'], additionalProperties: false };
    const schema = normalizePluginJsonSchema({ type: 'array', items: [item, { type: 'number' }], additionalItems: item });
    const adapter = createPluginJsonSchemaZodValueAdapter(schema);
    const stored = createStoredReadSchema(adapter);
    const value = [{ name: 'first', retired: true }, 1, { name: 'rest', retired: true }];
    expect(adapter.safeParse(value).success).toBe(false);
    expect(stored.parse(value)).toEqual([{ name: 'first' }, 1, { name: 'rest' }]);
    expect(stored.safeParse([{ name: 'first' }, 'wrong', { name: 'rest' }]).success).toBe(false);
    expect(isRecursivelyClosedPluginJsonSchemaV2(schema)).toBe(true);
    expect(isRecursivelyClosedPluginJsonSchemaV2({ ...schema, items: [{ ...item, additionalProperties: true }] })).toBe(false);
    expect(isRecursivelyClosedPluginJsonSchemaV2({ ...schema, additionalItems: { ...item, additionalProperties: true } })).toBe(false);
    expect(resolveDeclaredInputLeaves({ type: 'object', properties: { tuple: schema } }, 'tuple.[].name', 'review-field'))
      .toEqual([{ type: 'string' }, { type: 'string' }]);
  });

  it('rejects malformed declarations nested in tuple members and rest schemas', () => {
    for (const schema of [
      { type: 'array', items: [{ type: 'string', enum: [] }] },
      { type: 'array', items: [], additionalItems: { type: 'string', enum: [] } },
      { type: 'array', items: [true] },
      { type: 'array', items: [], additionalItems: [] },
    ]) expect(() => normalizePluginJsonSchema(schema)).toThrow();
  });

  it('retains tuple array structure through Collection normalization and refuses reordered positions', () => {
    const normalize = (items: object[]) => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tuples',
      contribution: PluginAccountCollectionContributionV1Schema.parse({
        id: 'entries', schemaVersion: 1, serverReadable: ['id'], indexes: [],
        schema: { type: 'object', properties: { id: { type: 'string' },
          value: { type: 'array', items, additionalItems: false } },
        required: ['id', 'value'], additionalProperties: false },
      }),
    });
    const source = normalize([{ type: 'string' }, { type: 'number' }]);
    const wider = normalize([{ type: 'string' }, { type: 'number', title: 'Number' }]);
    const reordered = normalize([{ type: 'number' }, { type: 'string' }]);
    const validate = compilePluginJsonSchema(source.schema);
    expect(validate({ id: 'one', value: ['label', 1] })).toBe(true);
    expect(validate({ id: 'one', value: [1, 'label'] })).toBe(false);
    expect(isPluginCollectionSchemaWideningV1({ source, target: wider })).toBe(true);
    expect(isPluginCollectionSchemaWideningV1({ source, target: reordered })).toBe(false);
  });
});
