import { describe, expect, it } from 'vitest';

import { forEachJsonSchemaChild, zodSchemaToJsonSchemaObject, type JsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { SessionRunStreamReadEnvelopeSchema } from '../../sessions/control/contract.js';

describe('Plugin JSON Schema projection in the Run stream', () => {
  it.each(['draft-7', 'draft-2020-12'] as const)('projects the constraint declaration in %s', (target) => {
    const projection = zodSchemaToJsonSchemaObject(SessionRunStreamReadEnvelopeSchema, { target });
    const constraints: unknown[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const schema = node as JsonSchemaObject;
      const properties = schema.properties as JsonSchemaObject | undefined;
      const constraint = properties?.['x-happier-value-constraints'];
      if (constraint !== undefined) constraints.push(constraint);
      forEachJsonSchemaChild(schema, visit);
    };
    visit(projection);

    expect(constraints).toContainEqual(expect.objectContaining({
      type: 'array',
      items: expect.objectContaining({
        type: 'object',
        required: ['kind', 'left', 'right'],
        additionalProperties: false,
      }),
    }));
  });
});
