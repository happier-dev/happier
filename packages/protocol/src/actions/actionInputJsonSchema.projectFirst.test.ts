import { describe, expect, it } from 'vitest';

// A separate isolated file supplies the cold Project-first graph. Resetting an
// already imported catalog inside a test leaves its cyclic imports in flight.
import '../projects/projectContextV1.js';
import { getActionSpec } from './actionSpecs.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';

describe('Project-first Action catalog', () => {
  it('publishes Project Action schemas when the Project owner is imported before the Action catalog', () => {
    for (const [id, targetField] of [
      ['projects.context.update', 'target'],
      ['projects.visibility.set', 'target'],
      ['projects.organization.update', 'projectRef'],
    ] as const) {
      const spec = getActionSpec(id);
      expect(spec.inputSchema, id).toBeDefined();
      expect(spec.outputSchema, id).toBeDefined();
      expect(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' }), id)
        .toMatchObject({ type: 'object', required: expect.arrayContaining([targetField, 'expectedRevision']) });
    }
  });
});
