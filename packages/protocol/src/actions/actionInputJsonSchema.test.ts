import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActionJsonSchemaProjectionError,
  zodSchemaToJsonSchemaObject,
} from './actionInputJsonSchema.js';

describe('actionInputJsonSchema', () => {
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
