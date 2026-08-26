import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import * as ProtocolPublic from '../../index.js';

import { AutomationIdV1Schema } from '../../automations/automationIdV1.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { PluginTargetedContributionSelectionV1Schema } from '../ui/targetedContributions.js';
import * as protocolComposableKernel from './jsonSchemaValidation.js';
import {
  compilePluginJsonSchema,
  createPluginJsonSchemaZodObjectAdapter,
  defineProtocolJsonValue,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUniqueArray,
  isValidPluginJsonSchemaValue,
  normalizePluginJsonSchema,
  preparePluginJsonSchema,
  rehydrateCanonicalProtocolComposableSchema,
  type ProtocolComposableSchema,
  type ProtocolJsonValue,
} from './jsonSchemaValidation';

function deepSortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortObjectKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, deepSortObjectKeys(child)]),
  );
}

describe('plugin JSON Schema validation policy', () => {
  it('enforces Protocol-owned byte ceilings at the canonical compiler boundary', () => {
    const validate = compilePluginJsonSchema({
      type: 'object',
      properties: {
        text: { type: 'string', 'x-happier-max-utf8-bytes': 4 },
        value: { 'x-happier-max-serialized-utf8-bytes': 6 },
      },
      required: ['text', 'value'],
      additionalProperties: false,
    });

    expect(validate({ text: 'éé', value: 'éé' })).toBe(true);
    expect(validate({ text: 'ééé', value: 'éé' })).toBe(false);
    expect(validate({ text: 'éé', value: 'ééé' })).toBe(false);
    expect(() => compilePluginJsonSchema({
      type: 'string',
      'x-happier-max-utf8-bytes': 0,
    })).toThrow(/x-happier-max-utf8-bytes/u);
    expect(() => compilePluginJsonSchema({
      type: 'string',
      'x-happier-unbounded-bytes': 4,
    })).toThrow(/x-happier-unbounded-bytes/u);
  });

  it('keeps generic schema collection size independent from the tighter UI JSON collection boundary', () => {
    const schema = {
      enum: Array.from({ length: 8_193 }, (_, index) => index),
    };

    expect(() => compilePluginJsonSchema(schema)).not.toThrow();
  });

  it('validates nested null-prototype enum and const values with JSON semantics', () => {
    const validate = compilePluginJsonSchema({
      allOf: [
        { enum: [{ valueOf: 'literal', nested: [{ enabled: true }], amount: 4 }] },
        { const: { amount: 4, nested: [{ enabled: true }], valueOf: 'literal' } },
      ],
    });
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      amount: 4,
      nested: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
      valueOf: 'literal',
    });

    expect(isValidPluginJsonSchemaValue(validate, value)).toBe(true);
  });

  it('enforces uniqueItems with the same canonical JSON equality used by enum and const', () => {
    const validate = compilePluginJsonSchema({
      type: 'array',
      uniqueItems: true,
    });
    const unique = [
      Object.assign(Object.create(null) as Record<string, unknown>, {
        principal: 'principal-a',
        grants: ['read'],
      }),
      { principal: 'principal-b', grants: ['read'] },
    ];
    const duplicate = [
      Object.assign(Object.create(null) as Record<string, unknown>, {
        principal: 'principal-a',
        grants: ['read'],
      }),
      { grants: ['read'], principal: 'principal-a' },
    ];

    expect(validate(unique)).toBe(true);
    expect(validate(duplicate)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, unique)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, duplicate)).toBe(false);
  });

  it('rejects accessor-backed values and schemas without invoking accessors', () => {
    const validate = compilePluginJsonSchema({ const: { valueOf: 'literal', enabled: true } });
    let reads = 0;
    const value = { enabled: true } as Record<string, unknown>;
    Object.defineProperty(value, 'valueOf', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('accessor must not execute');
      },
    });

    expect(isValidPluginJsonSchemaValue(validate, value)).toBe(false);

    const variants: unknown[] = [];
    Object.defineProperty(variants, '0', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('schema accessor must not execute');
      },
    });
    variants.length = 1;
    expect(() => compilePluginJsonSchema({ anyOf: variants })).toThrow();
    expect(reads).toBe(0);
  });

  it('rejects duplicate enum values, malformed schemas, and non-JSON instance values', () => {
    expect(() => compilePluginJsonSchema({
      enum: [{ first: 1, second: 2 }, { second: 2, first: 1 }],
    })).toThrow(/enum values must be unique/i);
    expect(() => compilePluginJsonSchema({ enum: [-0, 0] })).toThrow(/enum values must be unique/i);
    expect(() => compilePluginJsonSchema({ anyOf: [] })).toThrow();
    expect(() => compilePluginJsonSchema({ type: 'string', format: 'unsupported-format' })).toThrow(/format/u);

    const cyclicSchema: Record<string, unknown> = { type: 'object' };
    cyclicSchema.properties = { self: cyclicSchema };
    expect(() => compilePluginJsonSchema(cyclicSchema)).toThrow();

    const objectValidator = compilePluginJsonSchema({ type: 'object' });
    const cyclicValue: Record<string, unknown> = {};
    cyclicValue.self = cyclicValue;
    expect(isValidPluginJsonSchemaValue(objectValidator, cyclicValue)).toBe(false);
    expect(isValidPluginJsonSchemaValue(objectValidator, Object.create({ inherited: true }))).toBe(false);
  });

  it('normalizes the supported draft marker and validates the common format vocabulary', () => {
    expect(normalizePluginJsonSchema({
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'string',
      format: 'email',
    })).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
      format: 'email',
    });

    const validateEmail = compilePluginJsonSchema({ type: 'string', format: 'email' });
    expect(validateEmail('author@example.com')).toBe(true);
    expect(validateEmail('not-an-email')).toBe(false);
    expect(() => normalizePluginJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string',
    })).toThrow(/\$schema/u);
  });

  it('takes one recursively frozen schema snapshot for each admitted compiler boundary', () => {
    const source = {
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object' as const,
      properties: {
        items: {
          type: 'array' as const,
          items: { type: 'string' as const, minLength: 2 },
        },
      },
      required: ['items'],
      additionalProperties: false,
    };

    const prepared = preparePluginJsonSchema(source);
    const normalized = prepared.jsonSchema;
    const separatelyNormalized = normalizePluginJsonSchema(source);

    expect(prepared.jsonSchema).toBe(normalized);
    expect(separatelyNormalized).not.toBe(normalized);
    expect(separatelyNormalized).toEqual(normalized);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.properties)).toBe(true);
    expect(Object.isFrozen(normalized.properties.items)).toBe(true);
    expect(Object.isFrozen(normalized.properties.items.items)).toBe(true);
    expect(Object.isFrozen(normalized.required)).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);

    source.properties.items.items.minLength = 1;
    expect(normalized.properties.items.items.minLength).toBe(2);
    expect(Reflect.set(normalized.properties.items.items, 'minLength', 1)).toBe(false);
    expect(prepared.validate({ items: ['ok'] })).toBe(true);
    expect(prepared.validate({ items: ['x'] })).toBe(false);
  });
});

describe('plugin JSON Schema Zod object adapter', () => {
  it('presents an omitted plugin schema as the MCP empty object contract', () => {
    const adapter = createPluginJsonSchemaZodObjectAdapter({});

    expect(adapter.safeParse({}).success).toBe(true);
    expect(z.toJSONSchema(adapter, { target: 'draft-7' })).toMatchObject({
      type: 'object',
    });
  });

  it('preserves the bounded schema for presentation while delegating validation to the canonical compiler', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        selector: {
          const: {
            kind: 'workspace',
            paths: ['src', 'tests'],
          },
        },
      },
      required: ['selector'],
      additionalProperties: false,
    };

    const adapter = createPluginJsonSchemaZodObjectAdapter(schema);

    expect(adapter.safeParse({
      selector: {
        paths: ['src', 'tests'],
        kind: 'workspace',
      },
    }).success).toBe(true);
    expect(adapter.safeParse({
      selector: {
        kind: 'workspace',
        paths: ['src'],
      },
    }).success).toBe(false);
    expect(z.toJSONSchema(adapter, { target: 'draft-7' })).toMatchObject(schema);
  });
});

describe('protocol composable schema kernel', () => {
  it('keeps the public Protocol barrel importable without treating composables as Zod schemas', () => {
    expect(ProtocolPublic.PluginIdSchema.safeParse('happier.test').success).toBe(true);
    expect(Reflect.ownKeys(ProtocolPublic.PluginIdSchema).sort()).toEqual([
      'jsonSchema',
      'nullable',
      'optional',
      'parse',
      'safeParse',
    ]);
  });

  it('exposes each canonical constructor result as exactly the neutral five-member plain object', () => {
    const schema = defineProtocolObject({
      kind: defineProtocolLiteral('identity'),
    }, { policy: 'closed' });

    const assertNeutralSurface = (value: object) => {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Reflect.ownKeys(value).sort()).toEqual([
        'jsonSchema',
        'nullable',
        'optional',
        'parse',
        'safeParse',
      ]);
      expect(value).not.toHaveProperty('_zod');
      expect(value).not.toHaveProperty('refine');
      expect(value).not.toHaveProperty('transform');
      expect(value).not.toHaveProperty('parseAsync');
    };

    assertNeutralSurface(schema);
    assertNeutralSurface(schema.optional());
    assertNeutralSurface(schema.nullable());
  });

  it('admits a composable member only on its complete five-member surface', () => {
    const complete = defineProtocolString({ minLength: 1 });
    expect(defineProtocolObject({ label: complete }, { policy: 'closed' }).jsonSchema)
      .toMatchObject({ properties: { label: { type: 'string' } } });

    // A plain JSON Schema is manifest data, never an executable member.
    expect(() => defineProtocolObject(
      { label: { type: 'string' } } as unknown as Readonly<
        Record<string, ProtocolComposableSchema<unknown, unknown>>
      >,
      { policy: 'closed' },
    )).toThrow(TypeError);

    // Each member is load-bearing: dropping exactly one from an otherwise
    // complete composable must not be accepted as a second schema spelling.
    for (const omitted of ['jsonSchema', 'parse', 'safeParse', 'optional', 'nullable'] as const) {
      const partial: Record<string, unknown> = { ...complete };
      // `parse`/`safeParse`/`optional`/`nullable` are own enumerable members of
      // the neutral plain object, so a spread copy carries all five.
      expect(Object.hasOwn(partial, omitted)).toBe(true);
      delete partial[omitted];
      expect(() => defineProtocolObject(
        { label: partial } as unknown as Readonly<
          Record<string, ProtocolComposableSchema<unknown, unknown>>
        >,
        { policy: 'closed' },
      )).toThrow(TypeError);
    }
  });

  it('composes a mutable structural schema across copies without an identity gate', () => {
    const copy = <TInput, TOutput>(
      source: ProtocolComposableSchema<TInput, TOutput>,
    ): ProtocolComposableSchema<TInput, TOutput> => ({
      jsonSchema: structuredClone(source.jsonSchema),
      parse(value: unknown): TOutput {
        return source.parse(value);
      },
      safeParse(value: unknown) {
        return source.safeParse(value);
      },
      optional() {
        return copy(source.optional());
      },
      nullable() {
        return copy(source.nullable());
      },
    });
    const copiedString = copy(defineProtocolString({ minLength: 2 }));
    const schema = defineProtocolObject({
      optionalLabel: copiedString.optional(),
      nullableLabel: copiedString.nullable(),
    }, { policy: 'closed' });
    const validates = compilePluginJsonSchema(schema.jsonSchema);

    expect(Object.isFrozen(copiedString)).toBe(false);
    expect(Object.isFrozen(copiedString.jsonSchema)).toBe(false);
    expect(Object.getOwnPropertySymbols(copiedString)).toEqual([]);
    for (const value of [
      { nullableLabel: null },
      { optionalLabel: 'ok', nullableLabel: 'also ok' },
    ]) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(isValidPluginJsonSchemaValue(validates, value)).toBe(true);
    }
    for (const value of [
      { nullableLabel: undefined },
      { optionalLabel: 'x', nullableLabel: null },
      { nullableLabel: 1 },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
      expect(isValidPluginJsonSchemaValue(validates, value)).toBe(false);
    }
  });

  it('rehydrates optional object fields without making the enclosing schema optional', () => {
    const authored = defineProtocolObject({
      requiredLabel: defineProtocolString({ minLength: 1 }),
      optionalLabel: defineProtocolString({ minLength: 1 }).optional(),
    }, { policy: 'closed' });
    const rehydrated = rehydrateCanonicalProtocolComposableSchema(authored.jsonSchema);

    expect(rehydrated).not.toBeNull();
    if (rehydrated === null) throw new Error('Expected the canonical object schema to rehydrate');
    expectTypeOf(rehydrated).toEqualTypeOf<
      ProtocolComposableSchema<ProtocolJsonValue, ProtocolJsonValue>
    >();
    expect(rehydrated.safeParse({ requiredLabel: 'ready' })).toEqual({
      success: true,
      data: { requiredLabel: 'ready' },
    });
    expect(rehydrated.safeParse({}).success).toBe(false);
    expect(rehydrated.safeParse(undefined).success).toBe(false);
  });

  it('rehydrates canonical object schemas after manifest key ordering', () => {
    const authored = defineProtocolObject({
      zeta: defineProtocolString({ minLength: 1 }),
      alpha: defineProtocolString({ minLength: 1 }).optional(),
      beta: defineProtocolObject({
        zetaNested: defineProtocolString({ minLength: 1 }),
        alphaNested: defineProtocolString({ minLength: 1 }).optional(),
        betaNested: defineProtocolString({ minLength: 1 }),
      }, { policy: 'closed' }),
    }, { policy: 'closed' });
    const reordered = deepSortObjectKeys(authored.jsonSchema);
    if (typeof reordered !== 'object' || reordered === null || Array.isArray(reordered)) {
      throw new Error('Canonical schema projection must remain an object');
    }

    const rehydrated = rehydrateCanonicalProtocolComposableSchema(reordered);

    expect(rehydrated?.safeParse({
      zeta: 'z',
      beta: { zetaNested: 'nested-z', betaNested: 'nested-b' },
    })).toEqual({
      success: true,
      data: {
        zeta: 'z',
        beta: { zetaNested: 'nested-z', betaNested: 'nested-b' },
      },
    });
    expect(rehydrated?.safeParse({ zeta: 'z' }).success).toBe(false);
  });

  it('rehydrates exact nested unknown-key policies and declines merely valid JSON Schema', () => {
    const authored = defineProtocolObject({
      drop: defineProtocolObject({ label: defineProtocolString() }, { policy: 'additive-open/drop' }),
      preserve: defineProtocolObject({ label: defineProtocolString() }, { policy: 'additive-open/preserve' }),
      typed: defineProtocolObject({ label: defineProtocolString() }, {
        policy: 'additive-open/preserve',
        additionalProperties: defineProtocolString({ minLength: 1 }),
      }),
    }, { policy: 'closed' });
    const rehydrated = rehydrateCanonicalProtocolComposableSchema(authored.jsonSchema);

    expect(rehydrated?.safeParse({
      drop: { label: 'drop', future: 'discarded' },
      preserve: { label: 'preserve', future: 'retained' },
      typed: { label: 'typed', future: 'also-retained' },
    })).toEqual({
      success: true,
      data: {
        drop: { label: 'drop' },
        preserve: { label: 'preserve', future: 'retained' },
        typed: { label: 'typed', future: 'also-retained' },
      },
    });
    // The emitted DSL omits an empty required list. A hand-authored schema
    // remains valid JSON Schema but is not an exact canonical projection.
    expect(rehydrateCanonicalProtocolComposableSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })).toBeNull();
  });

  it('keeps unique-array input acceptance aligned with emitted JSON Schema before child normalization', () => {
    const schema = defineProtocolUniqueArray(defineProtocolObject({
      kind: defineProtocolLiteral('ready'),
    }, { policy: 'additive-open/drop' }));
    const validates = compilePluginJsonSchema(schema.jsonSchema);
    const distinctInput = [
      { kind: 'ready', localOnly: 'first' },
      { kind: 'ready', localOnly: 'second' },
    ];
    const duplicateInput = [
      { kind: 'ready', localOnly: 'same' },
      { kind: 'ready', localOnly: 'same' },
    ];

    // JSON Schema's `uniqueItems` compares the admitted input. The open/drop
    // child normalizes both distinct items to the same output, which must not
    // turn a schema-valid input into a parser rejection.
    expect(validates(distinctInput)).toBe(true);
    expect(schema.safeParse(distinctInput)).toEqual({
      success: true,
      data: [{ kind: 'ready' }, { kind: 'ready' }],
    });
    expect(validates(duplicateInput)).toBe(false);
    expect(schema.safeParse(duplicateInput).success).toBe(false);
  });

  it('takes one input snapshot for an untransformed JSON leaf', () => {
    const schema = defineProtocolJsonValue({ maxSerializedUtf8Bytes: 128 });
    expect(schema.safeParse({ nested: ['ready'] }).success).toBe(true);

    const originalFreeze = Object.freeze;
    let frozenObjectCount = 0;
    Object.freeze = ((value: object) => {
      frozenObjectCount += 1;
      return originalFreeze(value);
    }) as typeof Object.freeze;

    let result: ReturnType<typeof schema.safeParse>;
    try {
      result = schema.safeParse({ nested: ['ready'] });
    } finally {
      Object.freeze = originalFreeze;
    }

    expect(result.success).toBe(true);
    // One object and one array form the input snapshot; the third freeze is
    // the immutable parse-result envelope. A duplicate leaf or final snapshot
    // would raise this count.
    expect(frozenObjectCount).toBe(3);
  });

  it('projects typed additional properties through object parse results', () => {
    const values = defineProtocolObject({}, {
      policy: 'additive-open/preserve',
      additionalProperties: defineProtocolLiteral('ready'),
    });

    expectTypeOf(values.parse({})).toEqualTypeOf<Readonly<Record<string, 'ready'>>>();
    expect(values.parse({ first: 'ready' })).toEqual({ first: 'ready' });
    expect(values.safeParse({ first: 'other' }).success).toBe(false);
    expect(values.safeParse(['ready']).success).toBe(false);
  });

  it('keeps heterogeneous known fields constructible with typed preserved values', () => {
    const values = defineProtocolObject({
      state: defineProtocolLiteral('ready'),
    }, {
      policy: 'additive-open/preserve',
      additionalProperties: defineProtocolNumber({ integer: true, minimum: 0 }),
    });
    type Input = typeof values extends ProtocolComposableSchema<infer TInput, infer _TOutput>
      ? TInput
      : never;
    const input: Input = { state: 'ready', attempt: 1 };
    const output: ReturnType<typeof values.parse> = { state: 'ready', attempt: 1 };

    expectTypeOf<typeof input.state>().toEqualTypeOf<'ready'>();
    expectTypeOf<typeof output.state>().toEqualTypeOf<'ready'>();
    expectTypeOf<typeof input.attempt>().toEqualTypeOf<number | 'ready'>();
    expectTypeOf<typeof output.attempt>().toEqualTypeOf<number | 'ready'>();
    expect(input).toEqual({ state: 'ready', attempt: 1 });
    expect(output).toEqual({ state: 'ready', attempt: 1 });
  });

  it('does not retain a second root-publishing constructor', () => {
    expect(protocolComposableKernel).not.toHaveProperty('defineProtocolSchema');
  });

  it('keeps one neutral Protocol schema parser and JSON Schema projection', () => {
    const identity = defineProtocolObject({
      kind: defineProtocolLiteral('identity'),
    }, { policy: 'closed' });

    expect(identity.safeParse({ kind: 'identity' })).toEqual({
      success: true,
      data: { kind: 'identity' },
    });
    expect(identity.safeParse({ kind: 'other' })).toMatchObject({
      success: false,
      error: { issues: [{ path: ['kind'] }] },
    });
    expect(identity.jsonSchema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { kind: { const: 'identity' } },
      required: ['kind'],
      additionalProperties: false,
    });
    expect(Object.isFrozen(identity.jsonSchema)).toBe(true);
  });

  it('publishes each SDK-facing canonical root through the same parser and frozen schema projection', () => {
    const contribution = { pluginId: 'happier.test', localId: 'entry' };
    const roots: readonly Readonly<{
      schema: Readonly<{ safeParse(value: unknown): unknown }>;
      value: unknown;
    }>[] = [
      {
        schema: PluginTargetedContributionSelectionV1Schema,
        value: {
          target: { pluginId: 'happier.test', immutableGenerationId: 'generation' },
          point: { pointId: 'point', protocol: { id: 'happier.test/point', version: 1 } },
          contributor: {
            pluginId: 'happier.test',
            contributionId: 'entry',
            immutableGenerationId: 'generation',
          },
        },
      },
      { schema: PluginContributionIdentityV1Schema, value: contribution },
      {
        schema: QualifiedConnectedAccountRefSchema,
        value: { service: contribution, accountId: 'account' },
      },
      { schema: AgentPermissionIntentV1Schema, value: 'default' },
      { schema: SessionIdSchema, value: 'session' },
      { schema: AutomationIdV1Schema, value: 'automation' },
    ];

    for (const { schema, value } of roots) {
      const jsonSchema = Reflect.get(schema, 'jsonSchema');
      expect(jsonSchema).toMatchObject({
        $schema: 'http://json-schema.org/draft-07/schema#',
      });
      expect(Object.isFrozen(jsonSchema)).toBe(true);
      expect(schema.safeParse(value)).toMatchObject({ success: true, data: value });
    }
  });
});
