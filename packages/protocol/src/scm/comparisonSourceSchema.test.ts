import { describe, expect, it } from 'vitest';

import { admitCanonicalProtocolComposableSchema } from '../plugins/actions/protocolComposableSchema.js';
import { ScmComparisonSourceProtocolSchema } from './comparison.js';

describe('ScmComparisonSourceProtocolSchema', () => {
  // Plugin contribution points embed this source in their operation results (Triage's sources `get`).
  // A point whose schemas are not canonical loses its semantics, and every contribution to it is refused.
  it('projects a canonical composable schema that contribution-point semantics can admit', () => {
    expect(
      admitCanonicalProtocolComposableSchema(
        ScmComparisonSourceProtocolSchema.jsonSchema,
      ),
    ).not.toBeNull();
  });

  it('still accepts each working-tree area and the area-less working tree', () => {
    for (const area of ['included', 'pending', 'both'] as const) {
      expect(
        ScmComparisonSourceProtocolSchema.safeParse({
          kind: 'workingTree',
          area,
        }).success,
      ).toBe(true);
    }
    expect(
      ScmComparisonSourceProtocolSchema.safeParse({ kind: 'workingTree' })
        .success,
    ).toBe(true);
    expect(
      ScmComparisonSourceProtocolSchema.safeParse({
        kind: 'workingTree',
        area: 'staged',
      }).success,
    ).toBe(false);
  });
});
