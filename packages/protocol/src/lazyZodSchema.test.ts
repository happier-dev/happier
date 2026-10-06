import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { lazyZodSchema } from './lazyZodSchema.js';

describe('lazyZodSchema', () => {
  it('admits one concrete schema on use, while catalog references and derived definitions stay cold', () => {
    let constructed = 0;
    const schema = lazyZodSchema(() => {
      constructed++;
      return z.object({ id: z.string().trim().min(1), count: z.number().int().default(3) }).strict();
    });
    const derived = schema.extend({ enabled: z.boolean() }).partial();
    const optional = schema.optional();
    expect(typeof schema.parse).toBe('function');
    expect(typeof schema.safeParse).toBe('function');
    expect(constructed).toBe(0);
    expect(schema.parse({ id: ' a ' })).toEqual({ id: 'a', count: 3 });
    expect(schema.safeParse({ id: '' }).success).toBe(false);
    expect(schema.safeParse({ id: 'a', unknown: true }).success).toBe(false);
    expect(derived.parse({ enabled: true })).toEqual({ count: 3, enabled: true });
    expect(optional.parse(undefined)).toBeUndefined();
    expect(constructed).toBe(1);
    expectTypeOf(schema).toEqualTypeOf<z.ZodObject<{
      id: z.ZodString; count: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>();
  });

  it('composes with real parent parsing, union discrimination, reflection and JSON Schema export', async () => {
    const schema = lazyZodSchema(() => z.object({ kind: z.literal('item'), id: z.string() }).strict());
    const parent = z.object({ item: schema.optional() }).strict();
    expect(await parent.parseAsync({ item: { kind: 'item', id: 'a' } })).toEqual({ item: { kind: 'item', id: 'a' } });
    expect(parent.safeParse({ item: { kind: 'item', id: 1 } }).success).toBe(false);
    const union = z.discriminatedUnion('kind', [schema, z.object({ kind: z.literal('empty') }).strict()]);
    expect(union.parse({ kind: 'item', id: 'a' })).toEqual({ kind: 'item', id: 'a' });
    expect(schema instanceof z.ZodObject).toBe(true);
    expect(schema.shape.id instanceof z.ZodString).toBe(true);
    expect(z.toJSONSchema(schema)).toEqual(z.toJSONSchema(z.object({ kind: z.literal('item'), id: z.string() }).strict()));
    const documented = lazyZodSchema(() => z.object({ id: z.string().describe('Identifier') })
      .describe('Documented object').meta({ title: 'Object title' }));
    expect(z.toJSONSchema(documented)).toEqual(z.toJSONSchema(z.object({ id: z.string().describe('Identifier') })
      .describe('Documented object').meta({ title: 'Object title' })));
    expect(Reflect.ownKeys(schema)).toContain('_zod');
    Object.freeze(schema);
    expect(schema.parse({ kind: 'item', id: 'b' })).toEqual({ kind: 'item', id: 'b' });
  });

  it('preserves recoverable construction failure and Zod issue paths', () => {
    let ready = false;
    const schema = lazyZodSchema(() => {
      if (!ready) throw new Error('definition unavailable');
      return z.object({ value: z.number().positive() }).strict();
    });
    expect(() => schema.parse({ value: 2 })).toThrow('definition unavailable');
    ready = true;
    expect(schema.parse({ value: 2 })).toEqual({ value: 2 });
    const parsed = schema.safeParse({ value: -1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['value']);
  });

  it('projects nested lazy and optional facades using the traversal identity without weakening parsing', () => {
    const concrete = z.object({ id: z.string().min(1) }).strict().describe('Action arguments');
    const optional = lazyZodSchema(() => concrete.optional());
    const deferred = lazyZodSchema(() => z.lazy(() => concrete));
    const parent = z.object({ optional, repeated: z.array(deferred) }).strict();
    const expected = z.object({ optional: concrete.optional(), repeated: z.array(z.lazy(() => concrete)) }).strict();

    for (const target of ['draft-2020-12', 'draft-7'] as const) {
      expect(z.toJSONSchema(parent, { target, io: 'input' })).toEqual(
        z.toJSONSchema(expected, { target, io: 'input' }),
      );
      expect(parent.toJSONSchema({ target, io: 'input' })).toEqual(
        expected.toJSONSchema({ target, io: 'input' }),
      );
    }
    expect(parent.parse({ repeated: [{ id: 'a' }] })).toEqual({ repeated: [{ id: 'a' }] });
    expect(parent.safeParse({ repeated: [{ id: '' }] }).success).toBe(false);
    expect(parent.safeParse({ optional: { id: 'a', extra: true }, repeated: [] }).success).toBe(false);
    expect(parent.safeParse({ repeated: [{ id: 'a', extra: true }] }).success).toBe(false);
  });
});
