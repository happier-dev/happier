import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { lazyZodSchema } from './lazyZodSchema.js';

describe('lazyZodSchema', () => {
  it('preserves constraints of a derived facade reused through defaults and arrays', () => {
    const base = lazyZodSchema(() => z.object({ name: z.string().nullable() }).strict());
    const account = lazyZodSchema(() => base.extend({ kind: z.literal('account'), accountId: z.string().min(1) }).strict());
    const schema = lazyZodSchema(() => z.object({
      owner: account.nullable().optional().default(null),
      audience: z.object({ accounts: z.array(account) }).strict().nullable().optional().default(null),
    }).strict());
    const concrete = z.object({ name: z.string().nullable() }).strict()
      .extend({ kind: z.literal('account'), accountId: z.string().min(1) }).strict();
    const expected = z.object({
      owner: concrete.nullable().optional().default(null),
      audience: z.object({ accounts: z.array(concrete) }).strict().nullable().optional().default(null),
    }).strict();
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      for (const io of ['input', 'output'] as const) {
        expect(z.toJSONSchema(schema, { target, io })).toEqual(z.toJSONSchema(expected, { target, io }));
      }
    }
    expect(schema.parse({ audience: { accounts: [{ name: null, kind: 'account', accountId: 'a' }] } }))
      .toEqual({ owner: null, audience: { accounts: [{ name: null, kind: 'account', accountId: 'a' }] } });
    expect(schema.safeParse({ audience: { accounts: [{}] } }).success).toBe(false);
  });
  it('preserves a refined recursive definition identity in both JSON Schema dialects', () => {
    type Tree = { items?: Tree[] };
    const tree: z.ZodType<Tree> = z.lazy(() => z.object({ items: z.array(tree).optional() }).strict());
    const concrete = tree.superRefine(() => {});
    const schema = lazyZodSchema(() => concrete);
    const parent = z.object({ first: schema, second: schema.optional(), items: z.array(schema) }).strict();
    const expected = z.object({ first: concrete, second: concrete.optional(), items: z.array(concrete) }).strict();
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      for (const io of ['input', 'output'] as const) {
        for (const reused of ['inline', 'ref'] as const) {
          expect(z.toJSONSchema(parent, { target, io, reused })).toEqual(z.toJSONSchema(expected, { target, io, reused }));
        }
      }
    }
  });
  it('shares projection identity with native parents produced by deferred composition', () => {
    const schema = lazyZodSchema(() => z.string().min(1));
    const derived = schema.nullable().optional();
    const parent = z.object({ first: schema, second: derived, repeated: z.array(derived) }).strict();
    const concrete = z.string().min(1);
    const expectedDerived = concrete.nullable().optional();
    const expected = z.object({ first: concrete, second: expectedDerived, repeated: z.array(expectedDerived) }).strict();
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      for (const io of ['input', 'output'] as const) {
        for (const reused of ['inline', 'ref'] as const) {
          expect(z.toJSONSchema(parent, { target, io, reused })).toEqual(z.toJSONSchema(expected, { target, io, reused }));
        }
      }
    }
  });
  it('keeps scalar constraints and object key derivation cold until their validator is used', () => {
    let constructed = 0;
    const text = lazyZodSchema(() => {
      constructed++;
      return z.string();
    });
    const constrained = text.trim().min(2).max(4).regex(/^[a-z]+$/u);
    const object = lazyZodSchema(() => {
      constructed++;
      return z.object({ id: constrained, count: z.number() }).strict();
    });
    const keys = object.keyof();
    expect(constructed).toBe(0);
    expect(constrained.parse(' ab ')).toBe('ab');
    expect(constrained.safeParse('a').success).toBe(false);
    expect(constrained.safeParse('abcde').success).toBe(false);
    expect(constrained.safeParse('12').success).toBe(false);
    expect(constructed).toBe(1);
    expect(keys.parse('count')).toBe('count');
    expect(keys.safeParse('unknown').success).toBe(false);
    expect(object.parse({ id: ' ab ', count: 1 })).toEqual({ id: 'ab', count: 1 });
    expect(constructed).toBe(2);
    const expected = z.object({ id: z.string().trim().min(2).max(4).regex(/^[a-z]+$/u), count: z.number() }).strict();
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      expect(z.toJSONSchema(object, { target, io: 'input' })).toEqual(z.toJSONSchema(expected, { target, io: 'input' }));
    }
  });
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
