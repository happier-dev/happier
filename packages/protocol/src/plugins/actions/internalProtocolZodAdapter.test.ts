import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as mini from 'zod/mini';

import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { compileActionInputJsonSchema } from '../../actions/actionInputJsonSchemaValidation.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { LaunchProfileIdV2ProtocolSchema } from '../../profiles/v2/profileId.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod, projectZodProtocolSchema } from './internalProtocolZodAdapter.js';
import { createProtocolStoredReadSchema, defineProtocolArray, defineProtocolJsonValue, defineProtocolObject, defineProtocolString, defineProtocolUnion, defineProtocolUniqueArray } from './protocolComposableSchema.js';

import * as strictJson from '../contributions/strictJsonValue.js';

describe('the private neutral-schema bridge for Mini parents', () => {
  it('composes and parses projected native schemas without constructing JSON documents', () => {
    const clones = vi.spyOn(strictJson, 'cloneStrictPluginJsonValue');
    try {
      const projected = projectZodProtocolSchema(mini.strictObject({ id: mini.string() }));
      const parent = defineProtocolObject({ item: projected.optional() }, { policy: 'closed' });
      expect(parent.parse({ item: { id: 'accepted' } })).toEqual({ item: { id: 'accepted' } });
      expect(parent.safeParse({ item: { id: 7 } }).success).toBe(false);
      expect(clones.mock.calls.filter(([, path]) => path === 'schema')).toHaveLength(0);
      expect(structuredClone(parent.jsonSchema)).toEqual(parent.jsonSchema);
    } finally {
      clones.mockRestore();
    }
  });

  it('returns a native Mini schema that composes in a Mini parent', () => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const adapter = asProtocolZod(canonical);
    expect(adapter).toBeInstanceOf(mini.ZodMiniType);
    const parent = mini.strictObject({ payload: mini._default(adapter, { value: 'fallback' }) });
    expect(mini.parse(parent, {})).toEqual({ payload: { value: 'fallback' } });
    expect(mini.parse(parent, { payload: { value: 'kept' } })).toEqual({ payload: { value: 'kept' } });
    expect(mini.safeParse(parent, { payload: { value: 'kept', retired: true } }).success).toBe(false);
    expect(createStoredReadSchema(parent).parse({ payload: { value: 'kept', retired: true }, retired: true }))
      .toEqual({ payload: { value: 'kept' } });
  });

  it('reads retained canonical contribution identity annotations without weakening known fields or fresh input', () => {
    const identity = { pluginId: 'happier.agent.codex', localId: 'codex' };
    const retained = { ...identity, retired: true };
    const stored = createProtocolStoredReadSchema(PluginContributionIdentityV1Schema);
    expect(PluginContributionIdentityV1Schema.parse(identity)).toEqual(identity);
    expect(stored.parse(identity)).toEqual(identity);
    expect(stored.parse(retained)).toEqual(identity);
    expect(stored.safeParse({ ...retained, localId: 7 }).success).toBe(false);
    expect(PluginContributionIdentityV1Schema.safeParse(retained).success).toBe(false);
  });

  it('preserves canonical normalization before known bounds through stored nested compositions', () => {
    const id = LaunchProfileIdV2ProtocolSchema;
    const row = defineProtocolObject({ id }, { policy: 'closed' });
    const schema = defineProtocolObject({ rows: defineProtocolArray(row.optional().nullable()) }, { policy: 'closed' });
    const value = 'é'.repeat(256);
    expect(schema.parse({ rows: [{ id: ` ${value} ` }, null] })).toEqual({ rows: [{ id: value }, null] });
    const retained = { rows: [{ id: ` ${value} `, retired: true }, null], retired: true };
    expect(createProtocolStoredReadSchema(schema).parse(retained)).toEqual({ rows: [{ id: value }, null] });
    expect(createStoredReadSchema(asProtocolZod(schema)).parse(retained)).toEqual({ rows: [{ id: value }, null] });
    expect(createProtocolStoredReadSchema(schema).safeParse({ rows: [{ id: 'é'.repeat(257), retired: true }] }).success).toBe(false);
    expect(schema.safeParse(retained).success).toBe(false);
    const union = defineProtocolUnion([
      defineProtocolObject({ a: defineProtocolString({ minLength: 5 }) }, { policy: 'closed' }),
      defineProtocolObject({ b: id }, { policy: 'closed' }),
    ]);
    expect(createProtocolStoredReadSchema(union).parse({ a: 'x', b: ` ${value} `, retired: true }))
      .toEqual({ b: value });
  });

  it('checks unique stored rows after canonical normalization and preserves opaque declared JSON', () => {
    const row = defineProtocolObject({ id: LaunchProfileIdV2ProtocolSchema }, { policy: 'closed' });
    const schema = defineProtocolObject({
      rows: defineProtocolUniqueArray(row, { maxItems: 2 }),
      payload: defineProtocolJsonValue(),
    }, { policy: 'closed' });
    const stored = createProtocolStoredReadSchema(schema);
    const payload = { authorData: { retired: true }, arbitrary: ['kept'] };
    expect(stored.parse({ rows: [{ id: ' a ', retired: true }], payload, retired: true }))
      .toEqual({ rows: [{ id: 'a' }], payload });
    expect(stored.safeParse({ rows: [{ id: 'a', retired: true }, { id: ' a ', retired: false }], payload }).success).toBe(false);
    expect(stored.safeParse({ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], payload }).success).toBe(false);
    expect(stored.safeParse({ rows: [], payload: { invalid: undefined } }).success).toBe(false);
  });

  it('reuses the facade for one immutable canonical definition, not equal projection documents', () => {
    const canonical = defineProtocolString({ minLength: 1 });
    const adapter = asProtocolZod(canonical);
    expect(asProtocolZod(canonical)).toBe(adapter);
    const otherDefinition = defineProtocolString({ minLength: 1 });
    expect(otherDefinition.jsonSchema).toEqual(canonical.jsonSchema);
    expect(asProtocolZod(otherDefinition)).not.toBe(adapter);
    expect(adapter.parse('accepted')).toBe('accepted');
    expect(adapter.safeParse('').success).toBe(false);
  });

  it('keeps native Mini defaults and the canonical normalized output', async () => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'additive-open/drop' });
    const adapter = asProtocolZod(canonical);
    expectTypeOf(adapter).toMatchTypeOf<mini.ZodMiniType<{ value: string }, { value: string }>>();
    expect(adapter).toBeInstanceOf(mini.ZodMiniType);
    const parent = mini.strictObject({ payload: mini._default(adapter, () => ({ value: 'default' })) });
    expect(parent.parse({})).toEqual({ payload: { value: 'default' } });
    expect(await parent.parseAsync({ payload: { value: 'accepted', extra: true } })).toEqual({ payload: { value: 'accepted' } });
    const first = parent.parse({});
    first.payload.value = 'changed';
    expect(parent.parse({})).toEqual({ payload: { value: 'default' } });
    expect(mini.parse(mini.optional(adapter), undefined)).toBeUndefined();
    expect(mini.parse(mini.nullable(adapter), null)).toBeNull();
  });

  it('retains bridge issue paths and closes writes while stored reads drop extras', () => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const adapter = asProtocolZod(canonical);
    const parent = mini.strictObject({ payload: adapter });
    const parsed = parent.safeParse({ payload: { value: 7 } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual([
      { code: 'custom', path: ['payload'], message: 'Value does not satisfy the protocol string constraint' },
    ]);
    const reported = parent.safeParse({ payload: { value: 7 } }, { reportInput: true });
    if (reported.success) throw new Error('The reported input remains invalid');
    expect(reported.error.issues[0]).toMatchObject({ input: { value: 7 } });
    expect(parent.safeParse({ payload: { value: 'accepted', extra: true } }).success).toBe(false);
    // Persistence parsing must not acquire an optional host-global dependency.
    vi.stubGlobal('structuredClone', undefined);
    try {
      expect(createStoredReadSchema(parent).parse({ payload: { value: 'accepted', extra: true }, extra: true }))
        .toEqual({ payload: { value: 'accepted' } });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(parent.safeParse({ payload: { value: 'accepted' }, extra: true }).success).toBe(false);
    expect(createStoredReadSchema(parent).safeParse({ payload: {} }).success).toBe(false);
  });

  it('exposes the original rejected input when a parent refinement explicitly opts in', async () => {
    const observed: unknown[] = [];
    const adapter = asProtocolZod(defineProtocolString({ minLength: 2 }));
    const ordinaryRefinement = vi.fn(() => false);
    expect(adapter.check(mini.refine(ordinaryRefinement)).safeParse('x').success).toBe(false);
    expect(ordinaryRefinement).not.toHaveBeenCalled();
    const parent = adapter.check(mini.refine(
      value => { observed.push(value); return value !== 'x'; },
      { when: () => true, message: 'Parent rejected the original input' },
    ));
    const parsed = parent.safeParse('x');
    expect(observed).toEqual(['x']);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual([
      { code: 'custom', path: [], message: 'Value does not satisfy the protocol string constraint' },
      { code: 'custom', path: [], message: 'Parent rejected the original input' },
    ]);
    observed.length = 0;
    const asyncParsed = await parent.safeParseAsync('x');
    expect(asyncParsed.success).toBe(false);
    expect(observed).toEqual(['x']);
    if (!asyncParsed.success) expect(asyncParsed.error.issues).toEqual(parsed.success ? [] : parsed.error.issues);
    // An opted-in parent cannot turn failed canonical admission into success.
    expect(adapter.check(mini.refine(() => true, { when: () => true })).safeParse('x').success).toBe(false);
  });

  it('projects stored extras inside declared maps without discarding their data', () => {
    const canonical = defineProtocolObject({}, { policy: 'additive-open/preserve',
      additionalProperties: defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
    });
    const raw = { first: { value: 'kept', retired: true }, second: { value: 'also kept', retired: true } };
    const read = createStoredReadSchema(asProtocolZod(canonical));
    expect(read.parse(raw)).toEqual({ first: { value: 'kept' }, second: { value: 'also kept' } });
    expect(read.safeParse({ first: { value: '' } }).success).toBe(false);
    expect(canonical.safeParse(raw).success).toBe(false);
  });

  it.each(['draft-7', 'draft-2020-12'] as const)('preserves canonical custom projections in %s through Mini parents', (target) => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const parent = mini.strictObject({ payload: asProtocolZod(canonical), second: asProtocolZod(canonical) });
    const json = zodSchemaToJsonSchemaObject(parent, { target });
    expect(json).toMatchObject({
      type: 'object', required: ['payload', 'second'], additionalProperties: false,
    });
    const validate = compileActionInputJsonSchema(json);
    for (const input of [
      {},
      { payload: { value: 'accepted' } },
      { payload: { value: 'accepted' }, second: { value: 'other' } },
      { payload: { value: '' }, second: { value: 'other' } },
      { payload: { value: 'accepted', extra: true }, second: { value: 'other' } },
      { payload: { value: 7 }, second: { value: 'other' } },
    ]) {
      expect(validate(input)).toBe(parent.safeParse(input).success);
    }
    expect(canonical.jsonSchema).toMatchObject({ $schema: 'http://json-schema.org/draft-07/schema#' });
    expect(Object.getOwnPropertyDescriptor(json, '~standard')).toBeUndefined();
  });

  it('projects the canonical stored-read schema through Mini parents without replacing the parent dialect', () => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const adapter = asProtocolZod(canonical);
    const freshParent = mini.strictObject({ payload: adapter });
    const storedAdapter = createStoredReadSchema(adapter);
    const retained = { payload: { value: 'kept', retired: true } };

    expect(freshParent.safeParse(retained).success).toBe(false);
    const freshJson = zodSchemaToJsonSchemaObject(freshParent);
    expect(freshJson).toMatchObject({ properties: { payload: {
      type: 'object', properties: { value: { type: 'string', minLength: 1 } },
    } } });
    expect(compileActionInputJsonSchema(freshJson)(retained)).toBe(false);
    for (const parent of [mini.strictObject({ payload: storedAdapter }), createStoredReadSchema(freshParent)]) {
      expect(parent.parse(retained)).toEqual({ payload: { value: 'kept' } });
      const json = zodSchemaToJsonSchemaObject(parent);
      expect(json).toMatchObject({ properties: { payload: {
        type: 'object', additionalProperties: true,
        properties: { value: { type: 'string', minLength: 1 } }, required: ['value'],
      } } });
      const validate = compileActionInputJsonSchema(json);
      expect(validate(retained)).toBe(true);
      expect(validate({ payload: { value: '', retired: true } })).toBe(false);
    }
  });

  it('keeps typed map data and union bounds in the stored-read JSON projection', () => {
    const row = defineProtocolObject({ id: defineProtocolString({ minLength: 2 }) }, { policy: 'closed' });
    const canonical = defineProtocolObject({
      selection: defineProtocolUnion([row, defineProtocolObject({ note: defineProtocolString({ minLength: 3 }) }, { policy: 'closed' })]),
      typed: defineProtocolObject({}, { policy: 'additive-open/preserve', additionalProperties: row }),
    }, { policy: 'closed' });
    const read = createStoredReadSchema(asProtocolZod(canonical));
    const retained = { selection: { id: 'ab', retired: true }, typed: { first: { id: 'cd', retired: true } }, retired: true };
    expect(read.parse(retained)).toEqual({ selection: { id: 'ab' }, typed: { first: { id: 'cd' } } });
    expect(read.safeParse({ selection: { id: 'x' }, typed: {} }).success).toBe(false);
    const json = zodSchemaToJsonSchemaObject(mini.strictObject({ payload: read }));
    expect(json).toMatchObject({ properties: { payload: {
      additionalProperties: true,
      properties: {
        selection: { anyOf: [{ additionalProperties: true }, { additionalProperties: true }] },
        typed: { additionalProperties: { additionalProperties: true, properties: { id: { minLength: 2 } } } },
      },
    } } });
    const validate = compileActionInputJsonSchema(json);
    expect(validate({ payload: retained })).toBe(true);
    expect(validate({ payload: { selection: { id: 'x' }, typed: {} } })).toBe(false);
  });
});
