import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { asProtocolZod } from './internalProtocolZodAdapter.js';
import { defineProtocolObject, defineProtocolString } from './protocolComposableSchema.js';

describe('the private neutral-schema bridge for classic parents', () => {
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

  it('keeps the classic facade, defaults and the canonical normalized output', async () => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'additive-open/drop' });
    const adapter = asProtocolZod(canonical);
    expectTypeOf(adapter).toMatchTypeOf<z.ZodType<{ value: string }, { value: string }>>();
    expect(adapter).toBeInstanceOf(z.ZodType);
    const parent = z.object({ payload: adapter.default(() => ({ value: 'default' })) }).strict();
    expect(parent.parse({})).toEqual({ payload: { value: 'default' } });
    expect(await parent.parseAsync({ payload: { value: 'accepted', extra: true } })).toEqual({ payload: { value: 'accepted' } });
    const first = parent.parse({});
    first.payload.value = 'changed';
    expect(parent.parse({})).toEqual({ payload: { value: 'default' } });
    expect(adapter.optional().parse(undefined)).toBeUndefined();
    expect(adapter.nullable().parse(null)).toBeNull();
  });

  it('retains bridge issue paths and closes writes while stored reads drop extras', () => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const adapter = asProtocolZod(canonical);
    const parent = z.object({ payload: adapter }).strict();
    const parsed = parent.safeParse({ payload: { value: 7 } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual([
      { code: 'custom', path: ['payload'], message: 'Value does not satisfy the protocol string constraint' },
    ]);
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

  it('exposes the original rejected input when a parent refinement explicitly opts in', () => {
    const parent = asProtocolZod(defineProtocolString({ minLength: 2 })).refine(value => value !== 'x', {
      when: () => true,
      message: 'Parent rejected the original input',
    });
    const parsed = parent.safeParse('x');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual([
      { code: 'custom', path: [], message: 'Value does not satisfy the protocol string constraint' },
      { code: 'custom', path: [], message: 'Parent rejected the original input' },
    ]);
  });

  it.each(['draft-7', 'draft-2020-12'] as const)('preserves canonical custom projections in %s through classic parents', (target) => {
    const canonical = defineProtocolObject({ value: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
    const parent = z.object({ payload: asProtocolZod(canonical), second: asProtocolZod(canonical) }).strict();
    const json = zodSchemaToJsonSchemaObject(parent, { target });
    expect(json).toMatchObject({
      type: 'object', required: ['payload', 'second'], additionalProperties: false,
      properties: { payload: canonical.jsonSchema, second: canonical.jsonSchema },
    });
    expect(Object.getOwnPropertyDescriptor(json, '~standard')).toBeUndefined();
  });
});
