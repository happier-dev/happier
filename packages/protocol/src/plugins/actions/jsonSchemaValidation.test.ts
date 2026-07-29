import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createPluginJsonSchemaZodObjectAdapter } from './jsonSchemaValidation';

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
