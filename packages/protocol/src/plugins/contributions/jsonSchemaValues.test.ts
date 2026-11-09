import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';

import { pluginJsonValuesEqual } from './jsonSchemaValues';
import { PluginJsonSchemaV2Schema, PluginJsonValueV2Schema } from './jsonSchema.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';
import { compilePluginJsonSchema } from '../actions/jsonSchemaValidation.js';
import Ajv from 'ajv';

describe('structural JSON schema', () => {
  it('preserves admitted immutable schema identity without trusting caller-frozen documents', () => {
    const source = { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false };
    const admitted = normalizePluginJsonSchema(source);
    expect(PluginJsonSchemaV2Schema.parse(admitted)).toBe(admitted);
    expect(compilePluginJsonSchema(PluginJsonSchemaV2Schema.parse(admitted))).toBe(compilePluginJsonSchema(admitted));
    const mutable = structuredClone(admitted);
    const parsed = PluginJsonSchemaV2Schema.parse(mutable);
    expect(parsed).not.toBe(mutable);
    mutable.properties!.name!.type = 'number';
    expect(parsed.properties?.name?.type).toBe('string');
    expect(PluginJsonSchemaV2Schema.safeParse(Object.freeze({ type: 'invented' })).success).toBe(false);
    expect(PluginJsonSchemaV2Schema.safeParse(Object.freeze({ type: 'string', invented: true })).success).toBe(false);
  });

  it('parses deep JSON with exact invalid child paths and independent shared values', () => {
    let value: unknown = true;
    for (let index = 0; index < 1_200; index += 1) value = { next: [value] };
    expect(pluginJsonValuesEqual(PluginJsonValueV2Schema.parse(value), value)).toBe(true);
    const shared = { value: 1 };
    expect(PluginJsonValueV2Schema.parse([shared, shared])).toEqual([{ value: 1 }, { value: 1 }]);
    const invalid = PluginJsonValueV2Schema.safeParse({ nested: [Number.POSITIVE_INFINITY] });
    expect(invalid.success).toBe(false);
    if (invalid.success) throw new Error('expected invalid JSON number');
    expect(invalid.error.issues[0]?.path).toEqual(['nested', 0]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(PluginJsonValueV2Schema.safeParse(cyclic).success).toBe(false);
  });

  it('preserves structural JSON constraints in its recursive public projection', () => {
    const validate = new Ajv({ strict: false }).compile(z.toJSONSchema(PluginJsonValueV2Schema, { io: 'input', target: 'draft-7' }));
    expect(validate({ nested: [1, null, { text: 'value' }] })).toBe(true);
    expect(validate({ nested: [undefined] })).toBe(false);
  });

  it('retains the strict recursive JSON Schema vocabulary in native input and output projections', () => {
    for (const io of ['input', 'output'] as const) {
      const validate = new Ajv({ strict: false }).compile(z.toJSONSchema(PluginJsonSchemaV2Schema, { io, target: 'draft-7' }));
      expect(validate({ type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false })).toBe(true);
      expect(validate({ type: 'object', properties: { name: { type: 'invented' } } })).toBe(false);
      expect(validate({ type: 'string', invented: true })).toBe(false);
    }
  });
});

describe('pluginJsonValuesEqual', () => {
  it('compares 12,000-level strict JSON without recursive stack failure', () => {
    const createDeepValue = (terminal: string): unknown => {
      let value: unknown = terminal;
      for (let index = 0; index < 12_000; index += 1) {
        value = { next: value };
      }
      return value;
    };

    const left = createDeepValue('same');

    expect(pluginJsonValuesEqual(left, createDeepValue('same'))).toBe(true);
    expect(pluginJsonValuesEqual(left, createDeepValue('different'))).toBe(false);
  });

  it('compares nested null-prototype JSON independently of object key order', () => {
    const left = Object.assign(Object.create(null) as Record<string, unknown>, {
      second: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
      first: 4,
    });
    const right = { first: 4, second: [{ enabled: true }] };

    expect(pluginJsonValuesEqual(left, right)).toBe(true);
    expect(pluginJsonValuesEqual(right, left)).toBe(true);
  });

  it('accepts shared acyclic values as structural JSON', () => {
    const shared = { enabled: true };

    expect(pluginJsonValuesEqual(
      { first: shared, second: shared },
      { first: { enabled: true }, second: { enabled: true } },
    )).toBe(true);
  });

  it('uses finite JSON number semantics and keeps arrays ordered', () => {
    expect(pluginJsonValuesEqual(-0, 0)).toBe(true);
    expect(pluginJsonValuesEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
    expect(pluginJsonValuesEqual(Number.NaN, Number.NaN)).toBe(false);
    expect(pluginJsonValuesEqual([1, 2], [2, 1])).toBe(false);
  });

  it('does not equate values outside the strict JSON data model', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(pluginJsonValuesEqual(undefined, undefined)).toBe(false);
    expect(pluginJsonValuesEqual(new Date(0), {})).toBe(false);
    expect(pluginJsonValuesEqual([, 1], [undefined, 1])).toBe(false);
    expect(pluginJsonValuesEqual(cyclic, cyclic)).toBe(false);
  });

  it('rejects accessor-backed values without invoking their accessors', () => {
    let reads = 0;
    const hostile = { enabled: true } as Record<string, unknown>;
    Object.defineProperty(hostile, 'valueOf', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('accessor must not execute');
      },
    });

    expect(pluginJsonValuesEqual(hostile, { valueOf: 'literal', enabled: true })).toBe(false);
    expect(reads).toBe(0);
  });
});
