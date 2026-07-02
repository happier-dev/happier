import { describe, expect, it } from 'vitest';

import { PluginUiPredicateV1Schema } from './predicates.js';

describe('plugin UI predicates', () => {
  it('accepts inert JSON predicate values', () => {
    const result = PluginUiPredicateV1Schema.safeParse({
      operand: 'message.payload.equals',
      path: '/status',
      value: 'ready',
    });

    expect(result.success).toBe(true);
  });

  it('rejects executable predicate values', () => {
    const result = PluginUiPredicateV1Schema.safeParse({
      operand: 'message.payload.equals',
      path: '/status',
      value: () => 'ready',
    });

    expect(result.success).toBe(false);
  });
});
