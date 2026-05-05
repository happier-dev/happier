import { describe, expect, it } from 'vitest';

import { HookScopeV1Schema } from './hookScopes.js';

describe('HookScopeV1Schema', () => {
  it('accepts agent scope while preserving provider scope for compatibility readers', () => {
    expect(HookScopeV1Schema.parse('agent')).toBe('agent');
    expect(HookScopeV1Schema.parse('provider')).toBe('provider');
  });
});
