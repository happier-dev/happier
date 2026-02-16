import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('actionInputJsonSchema', () => {
  it('converts a zod object schema into a JSON schema object (no refs)', async () => {
    const { zodSchemaToJsonSchemaObject } = await import('./actionInputJsonSchema.js');

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

  it('converts string literals into string enums (for discriminators)', async () => {
    const { zodSchemaToJsonSchemaObject } = await import('./actionInputJsonSchema.js');

    const schema = z.object({
      kind: z.union([z.literal('none'), z.literal('branch')]),
    });

    const json = zodSchemaToJsonSchemaObject(schema);
    const kindSchema = (json as any)?.properties?.kind;

    // We support literals by representing them as a string with a single allowed value.
    expect(kindSchema).toMatchObject({
      oneOf: expect.any(Array),
    });
    expect(kindSchema.oneOf?.[0]).toMatchObject({ type: 'string' });
    expect(JSON.stringify(kindSchema)).toContain('none');
    expect(JSON.stringify(kindSchema)).toContain('branch');
  });
});
