import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod/mini';
import * as mini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from './lazyZodSchema.js';

describe('lazyZodSchema', () => {
  it('preserves native parsing when a deferred definition returns another cold definition', () => {
    const inner = lazyDefinition(() => z.strictObject({ id: z.string().check(z.minLength(1)) }));
    const outer = lazyDefinition(() => inner);
    expect(outer.parse({ id: 'kept' })).toEqual({ id: 'kept' });
    expect(outer).toBeInstanceOf(z.ZodMiniObject);
    expect(outer.safeParse({ id: '' }).success).toBe(false);
    expect(outer.safeParse({ id: 'kept', retired: true }).success).toBe(false);
  });

  it('keeps ordinary prototype inspection cold and preserves concrete Zod identity on use', () => {
    let constructed = 0;
    const schema = lazyZodSchema(() => {
      constructed++;
      return z.strictObject({ id: z.string() });
    });
    // Native console/error formatting inspects arbitrary values with instanceof.
    // Reflection must not run a definition factory or change its prototype mid-check.
    expect([schema].map(value => value instanceof Error)).toEqual([false]);
    expect(constructed).toBe(0);
    expect(schema.parse({ id: 'kept' })).toEqual({ id: 'kept' });
    expect(schema).toBeInstanceOf(z.ZodMiniObject);
    expect(Object.getPrototypeOf(schema)).toBe(z.ZodMiniObject.prototype);
    expect(constructed).toBe(1);
  });

  it('preserves the public identity when cloning an already parsed definition', () => {
    const source = lazyZodSchema(() => z.string());
    expect(source.parse('warm')).toBe('warm');
    const derived = source.clone().check(z.minLength(2));
    const concrete = z.string().check(z.minLength(2));
    expect(z.toJSONSchema(derived, { io: 'input' })).toEqual(z.toJSONSchema(concrete, { io: 'input' }));
    expect(derived.safeParse('x').success).toBe(false);
    expect(derived.parse('kept')).toBe('kept');
  });

  it('keeps a Mini definition cold through native default composition and independent defaults', () => {
    let constructed = 0;
    let defaults = 0;
    const schema = lazyZodSchema(() => {
      constructed++;
      return mini.strictObject({ id: mini.string().check(mini.minLength(1)) });
    });
    const parent = mini.strictObject({
      item: mini._default(schema, () => ({ id: `fallback-${++defaults}` })),
    });
    expect(constructed).toBe(0);
    expect(mini.parse(parent, {})).toEqual({ item: { id: 'fallback-1' } });
    expect(mini.parse(parent, {})).toEqual({ item: { id: 'fallback-2' } });
    expect(constructed).toBe(0);
    expect(mini.safeParse(parent, { item: { id: '', retired: true } }).success).toBe(false);
    expect(constructed).toBe(1);
    expect(mini.toJSONSchema(parent, { io: 'input' })).toMatchObject({
      properties: { item: { properties: { id: { type: 'string', minLength: 1 } } } },
    });
  });

  it('keeps a defaulted absent field cold while preserving native defaults and reverse validation', async () => {
    let constructed = 0;
    let defaults = 0;
    const schema = lazyZodSchema(() => {
      constructed++;
      return z.strictObject({ id: z.string().check(z.minLength(1)) });
    });
    const fallback = () => ({ id: `fallback-${++defaults}` });
    const defaulted = z._default(schema, fallback);
    const parent = z.strictObject({ item: defaulted });
    expect(z.parse(parent, {})).toEqual({ item: { id: 'fallback-1' } });
    expect(await z.parseAsync(parent, {})).toEqual({ item: { id: 'fallback-2' } });
    expect(z.parse(z.optional(defaulted), undefined)).toEqual({ id: 'fallback-3' });
    expect(constructed).toBe(0);
    expect(z.safeParse(parent, { item: { id: '', extra: true } }).success).toBe(false);
    expect(constructed).toBe(1);
    expect(z.safeEncode(defaulted, { id: '' }).success).toBe(false);
    expect(defaulted._zod.def.innerType).toBeInstanceOf(z.ZodMiniObject);
    const expected = z.strictObject({ item: z._default(z.strictObject({ id: z.string().check(z.minLength(1)) }), { id: 'fallback' }) });
    const projected = z.strictObject({ item: z._default(schema, { id: 'fallback' }) });
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      for (const io of ['input', 'output'] as const) {
        expect(z.toJSONSchema(projected, { target, io })).toEqual(z.toJSONSchema(expected, { target, io }));
      }
    }
  });
  it('preserves constraints of a derived facade reused through defaults and arrays', () => {
    const base = lazyZodSchema(() => z.strictObject({ name: z.nullable(z.string()) }));
    const account = lazyZodSchema(() => mini.extend(base, {
      kind: mini.literal('account'), accountId: mini.string().check(mini.minLength(1)),
    }));
    const schema = lazyZodSchema(() => z.strictObject({
      owner: z._default(z.optional(z.nullable(account)), null),
      audience: z._default(z.optional(z.nullable(z.strictObject({ accounts: z.array(account) }))), null),
    }));
    const concrete = mini.strictObject({
      name: mini.nullable(mini.string()), kind: mini.literal('account'),
      accountId: mini.string().check(mini.minLength(1)),
    });
    const expected = z.strictObject({
      owner: z._default(z.optional(z.nullable(concrete)), null),
      audience: z._default(z.optional(z.nullable(z.strictObject({ accounts: z.array(concrete) }))), null),
    });
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      for (const io of ['input', 'output'] as const) {
        expect(z.toJSONSchema(schema, { target, io })).toEqual(z.toJSONSchema(expected, { target, io }));
      }
    }
    expect(z.parse(schema, { audience: { accounts: [{ name: null, kind: 'account', accountId: 'a' }] } }))
      .toEqual({ owner: null, audience: { accounts: [{ name: null, kind: 'account', accountId: 'a' }] } });
    expect(z.safeParse(schema, { audience: { accounts: [{}] } }).success).toBe(false);
  });
  it('preserves a refined recursive definition identity in both JSON Schema dialects', () => {
    type Tree = { items?: Tree[] };
    const tree: z.ZodMiniType<Tree> = z.lazy(() => z.strictObject({ items: z.optional(z.array(tree)) }));
    const concrete = tree.check(z.superRefine(() => {}));
    const schema = lazyZodSchema(() => concrete);
    const parent = z.strictObject({ first: schema, second: z.optional(schema), items: z.array(schema) });
    const expected = z.strictObject({ first: concrete, second: z.optional(concrete), items: z.array(concrete) });
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      for (const io of ['input', 'output'] as const) {
        for (const reused of ['inline', 'ref'] as const) {
          expect(z.toJSONSchema(parent, { target, io, reused })).toEqual(z.toJSONSchema(expected, { target, io, reused }));
        }
      }
    }
  });
  it('shares projection identity with native parents produced by deferred composition', () => {
    const schema = lazyZodSchema(() => z.string().check(z.minLength(1)));
    const derived = z.optional(z.nullable(schema));
    const parent = z.strictObject({ first: schema, second: derived, repeated: z.array(derived) });
    const concrete = z.string().check(z.minLength(1));
    const expectedDerived = z.optional(z.nullable(concrete));
    const expected = z.strictObject({ first: concrete, second: expectedDerived, repeated: z.array(expectedDerived) });
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
    const constrained = lazyZodSchema(() => {
      constructed++;
      return mini.string().check(
        mini.trim(), mini.minLength(2), mini.maxLength(4), mini.regex(/^[a-z]+$/u),
      );
    });
    const object = lazyZodSchema(() => {
      constructed++;
      return z.strictObject({ id: constrained, count: z.number() });
    });
    const keys = lazyZodSchema(() => mini.keyof(object));
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
    const expected = z.strictObject({ id: z.string().check(z.trim(), z.minLength(2), z.maxLength(4), z.regex(/^[a-z]+$/u)), count: z.number() });
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      expect(z.toJSONSchema(object, { target, io: 'input' })).toEqual(z.toJSONSchema(expected, { target, io: 'input' }));
    }
  });
  it('admits one concrete schema on use, while catalog references and derived definitions stay cold', () => {
    let constructed = 0;
    const schema = lazyZodSchema(() => {
      constructed++;
      return z.strictObject({ id: z.string().check(z.trim(), z.minLength(1)), count: z._default(z.number().check(z.int()), 3) });
    });
    const derived = lazyZodSchema(() => z.partial(z.extend(schema, { enabled: z.boolean() })));
    const optional = z.optional(schema);
    expect(typeof schema.parse).toBe('function');
    expect(typeof schema.safeParse).toBe('function');
    expect(constructed).toBe(0);
    expect(schema.parse({ id: ' a ' })).toEqual({ id: 'a', count: 3 });
    expect(schema.safeParse({ id: '' }).success).toBe(false);
    expect(schema.safeParse({ id: 'a', unknown: true }).success).toBe(false);
    expect(z.parse(derived, { enabled: true })).toEqual({ count: 3, enabled: true });
    expect(z.parse(optional, undefined)).toBeUndefined();
    expect(constructed).toBe(1);
    expectTypeOf(schema).toEqualTypeOf<z.ZodMiniObject<{
      id: z.ZodMiniString; count: z.ZodMiniDefault<z.ZodMiniNumber>;
    }, z.core.$strict>>();
  });

  it('composes with real parent parsing, union discrimination, reflection and JSON Schema export', async () => {
    const schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('item'), id: z.string() }));
    const parent = z.strictObject({ item: z.optional(schema) });
    expect(await parent.parseAsync({ item: { kind: 'item', id: 'a' } })).toEqual({ item: { kind: 'item', id: 'a' } });
    expect(parent.safeParse({ item: { kind: 'item', id: 1 } }).success).toBe(false);
    const union = z.discriminatedUnion('kind', [schema, z.strictObject({ kind: z.literal('empty') })]);
    expect(union.parse({ kind: 'item', id: 'a' })).toEqual({ kind: 'item', id: 'a' });
    expect(schema instanceof z.ZodMiniObject).toBe(true);
    expect(schema.shape.id instanceof z.ZodMiniString).toBe(true);
    expect(z.toJSONSchema(schema)).toEqual(z.toJSONSchema(z.strictObject({ kind: z.literal('item'), id: z.string() })));
    const documented = lazyZodSchema(() => z.object({ id: z.string().check(z.describe('Identifier')) }).check(z.describe('Documented object'), z.meta({ title: 'Object title' })));
    expect(z.toJSONSchema(documented)).toEqual(z.toJSONSchema(z.object({ id: z.string().check(z.describe('Identifier')) }).check(z.describe('Documented object'), z.meta({ title: 'Object title' }))));
    expect(Reflect.ownKeys(schema)).toContain('_zod');
    Object.freeze(schema);
    expect(schema.parse({ kind: 'item', id: 'b' })).toEqual({ kind: 'item', id: 'b' });
  });

  it('preserves recoverable construction failure and Zod issue paths', () => {
    let ready = false;
    const schema = lazyZodSchema(() => {
      if (!ready) throw new Error('definition unavailable');
      return z.strictObject({ value: z.number().check(z.positive()) });
    });
    expect(() => schema.parse({ value: 2 })).toThrow('definition unavailable');
    ready = true;
    expect(schema.parse({ value: 2 })).toEqual({ value: 2 });
    const parsed = schema.safeParse({ value: -1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['value']);
  });

  it('projects nested lazy and optional facades using the traversal identity without weakening parsing', () => {
    const concrete = z.strictObject({ id: z.string().check(z.minLength(1)) }).check(z.describe('Action arguments'));
    const optional = lazyZodSchema(() => z.optional(concrete));
    const deferred = lazyZodSchema(() => z.lazy(() => concrete));
    const parent = z.strictObject({ optional, repeated: z.array(deferred) });
    const expected = z.strictObject({ optional: z.optional(concrete), repeated: z.array(z.lazy(() => concrete)) });

    for (const target of ['draft-2020-12', 'draft-7'] as const) {
      expect(z.toJSONSchema(parent, { target, io: 'input' })).toEqual(
        z.toJSONSchema(expected, { target, io: 'input' }),
      );
    }
    expect(parent.parse({ repeated: [{ id: 'a' }] })).toEqual({ repeated: [{ id: 'a' }] });
    expect(parent.safeParse({ repeated: [{ id: '' }] }).success).toBe(false);
    expect(parent.safeParse({ optional: { id: 'a', extra: true }, repeated: [] }).success).toBe(false);
    expect(parent.safeParse({ repeated: [{ id: 'a', extra: true }] }).success).toBe(false);
  });
});
