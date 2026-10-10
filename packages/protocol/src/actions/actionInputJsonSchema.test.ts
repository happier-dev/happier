import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as m from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationDefinitionCreateRequestSchema } from '../automations/automationApiV3.js';
import { compileActionInputJsonSchema } from './actionInputJsonSchemaValidation.js';
import { compilePluginJsonSchema, createPluginJsonSchemaZodObjectAdapter } from '../plugins/actions/jsonSchemaValidation.js';

import {
  ActionJsonSchemaProjectionError,
  zodSchemaToJsonSchemaObject,
} from './actionInputJsonSchema.js';

describe('actionInputJsonSchema', () => {
  it('projects genuine Mini lazy children without losing their input constraints', () => {
    const schema = z.object({
      name: m.lazy(() => m.string().check(m.minLength(2))),
    }).strict();
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      expect(zodSchemaToJsonSchemaObject(schema, { target })).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', minLength: 2 } },
      });
    }
  });

  it('validates its published recursive dialect while keeping Plugin admission draft-07-only', () => {
    const item = z.object({ name: z.string().min(1) }).strict();
    const input = z.object({ first: item, second: item, tuple: z.tuple([z.string(), z.number()]) }).strict();
    const published = zodSchemaToJsonSchemaObject(input);
    const validate = compileActionInputJsonSchema(published);
    expect(validate({ first: { name: 'one' }, second: { name: 'two' }, tuple: ['text', 1] })).toBe(true);
    expect(validate({ first: { name: '' }, second: { name: 'two' }, tuple: ['text', 1] })).toBe(false);
    expect(validate({ first: { name: 'one' }, second: { name: 'two' }, tuple: [1, 'text'] })).toBe(false);
    expect(() => compilePluginJsonSchema(published)).toThrow();
  });

  it('refuses non-local references in unused published Action definitions without interpreting literal JSON as schema', () => {
    for (const $ref of ['https://example.test/schema.json', 'other.json#/node', '#anchor']) {
      expect(() => compileActionInputJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'string', $defs: { unused: { $ref } },
      })).toThrow();
    }
    const validate = compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      const: { $ref: 'https://example.test/literal' },
    });
    expect(validate({ $ref: 'https://example.test/literal' })).toBe(true);
    expect(() => compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string', $async: true,
    })).toThrow();
  });

  it('retains Protocol strict JSON equality and UTF8 semantics in the published Action dialect', () => {
    const native = createPluginJsonSchemaZodObjectAdapter({
      type: 'object', properties: {
        text: { type: 'string', 'x-happier-max-utf8-bytes': 4 },
        values: { type: 'array', uniqueItems: true, items: { enum: [{ a: 1, b: 2 }] } },
      }, required: ['text', 'values'], additionalProperties: false,
    });
    const validate = compileActionInputJsonSchema(zodSchemaToJsonSchemaObject(native));
    expect(validate({ text: 'éé', values: [{ b: 2, a: 1 }] })).toBe(true);
    expect(validate({ text: 'ééé', values: [{ a: 1, b: 2 }] })).toBe(false);
    expect(validate({ text: 'éé', values: [{ a: 1, b: 2 }, { b: 2, a: 1 }] })).toBe(false);
    expect(() => compileActionInputJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string', 'x-happier-unbounded-bytes': 4,
    })).toThrow();
  });
  it('preserves the canonical JSON Schema constraints and descriptions that Action inputs advertise', () => {
    const schema = z.object({
      name: z.string().min(2).max(12).regex(/^[a-z]+$/).describe('Lowercase action name'),
      retries: z.number().min(1).max(5).describe('Retry limit'),
      tags: z.array(z.string().min(1)).min(1).max(3).describe('Action tags'),
      mode: z.enum(['safe', 'fast']).describe('Execution mode'),
      target: z.union([z.literal('workspace'), z.literal('project')]).describe('Execution target'),
    }).strict().describe('Agent action input');

    const json = zodSchemaToJsonSchemaObject(schema);

    expect(json).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      description: 'Agent action input',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          minLength: 2,
          maxLength: 12,
          pattern: '^[a-z]+$',
          description: 'Lowercase action name',
        },
        retries: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Retry limit',
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          description: 'Action tags',
          items: { type: 'string', minLength: 1 },
        },
        mode: {
          type: 'string',
          enum: ['safe', 'fast'],
          description: 'Execution mode',
        },
        target: {
          anyOf: [
            { type: 'string', const: 'workspace' },
            { type: 'string', const: 'project' },
          ],
          description: 'Execution target',
        },
      },
    });
    expect(json).toEqual(schema.toJSONSchema({
      io: 'input',
      target: 'draft-2020-12',
      unrepresentable: 'throw',
    }));
  });

  it('projects the same Action contract to draft-07 for consumers that require that dialect', () => {
    const json = zodSchemaToJsonSchemaObject(
      z.object({ value: z.string().trim().min(1) }).strict(),
      { target: 'draft-7' },
    );

    expect(json).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    });
  });

  it('uses the canonical open-object projection for passthrough schemas', () => {
    const json = zodSchemaToJsonSchemaObject(z.object({ value: z.string() }).passthrough());

    expect(json).toMatchObject({ type: 'object' });
    expect(json.additionalProperties).toEqual({});
  });

  it('does not leak Zod standard-schema metadata into the JSON boundary', () => {
    const json = zodSchemaToJsonSchemaObject(z.object({ value: z.string() }).strict());

    expect(Object.getOwnPropertyDescriptor(json, '~standard')).toBeUndefined();
  });

  it('rejects Zod constructs that cannot be represented by an Action JSON Schema', () => {
    let projectionError: unknown;
    try {
      zodSchemaToJsonSchemaObject(z.date());
    } catch (error) {
      projectionError = error;
    }

    expect(projectionError).toBeInstanceOf(ActionJsonSchemaProjectionError);
    expect(projectionError).toMatchObject({
      name: 'ActionJsonSchemaProjectionError',
      code: 'action_schema_unrepresentable',
    });
  });

  it('converts a zod object schema into a JSON schema object (no refs)', () => {
    const schema = z
      .object({
        sessionId: z.string().min(1).optional(),
        message: z.string().min(1),
        flags: z.array(z.string().min(1)).optional(),
      })
      .passthrough();

    const json = zodSchemaToJsonSchemaObject(schema);

    expect(json).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        sessionId: expect.any(Object),
        message: expect.any(Object),
      }),
    });
    expect((json as any).$ref).toBeUndefined();
    expect((json as any).definitions).toBeUndefined();
  });

  it('converts string literal unions through the canonical JSON Schema union', () => {
    const schema = z.object({
      kind: z.union([z.literal('none'), z.literal('branch')]),
    });

    const json = zodSchemaToJsonSchemaObject(schema);
    const kindSchema = (json as any)?.properties?.kind;

    // The Zod projection represents literal branches as JSON Schema constants.
    expect(kindSchema).toMatchObject({
      anyOf: expect.any(Array),
    });
    expect(kindSchema.anyOf?.[0]).toMatchObject({ type: 'string' });
    expect(JSON.stringify(kindSchema)).toContain('none');
    expect(JSON.stringify(kindSchema)).toContain('branch');
  });
});

it('projects Classic roots with genuine Mini children without weakening typed refusals', () => {
 const mini = lazyZodSchema(() => z.object({ name: m.string().check(m.trim(),m.minLength(1)), count: m._default(m.number().check(m.int()),3) }).strict());
 const classic = z.object({ name: z.string().trim().min(1), count: z.number().int().default(3) }).strict();
 for(const target of ['draft-7','draft-2020-12'] as const) {
  expect(zodSchemaToJsonSchemaObject(mini,{target})).toEqual(zodSchemaToJsonSchemaObject(classic,{target}));
  const unsupported = lazyZodSchema(() => z.object({ value: m.date() }).strict());
  expect(()=>zodSchemaToJsonSchemaObject(unsupported,{target})).toThrow(ActionJsonSchemaProjectionError);
  try { zodSchemaToJsonSchemaObject(unsupported,{target}); } catch(error) {
   expect(error).toMatchObject({name:'ActionJsonSchemaProjectionError',code:'action_schema_unrepresentable'});
  }
 }
 expect(mini.parse({name:' kept '})).toEqual(classic.parse({name:' kept '}));
 expect(()=>mini.parse({name:''})).toThrow(z.ZodError);
});
it('keeps ref-rich lazy Action roots at their concrete public projection', () => {
 const repeated=z.object({id:z.string().min(1)}).strict().describe('Repeated argument');
 const concrete=z.object({first:repeated,second:repeated}).strict();
 for(const target of ['draft-7','draft-2020-12'] as const) {
  expect(zodSchemaToJsonSchemaObject(lazyZodSchema(()=>concrete),{target})).toEqual(zodSchemaToJsonSchemaObject(concrete,{target}));
  const automation=zodSchemaToJsonSchemaObject(AutomationDefinitionCreateRequestSchema,{target});
  expect(automation).toMatchObject({type:'object',required:['automationId','name','enabled','executionRecipe','triggers']});
  expect(automation.$ref).toBeUndefined();
 }
});
