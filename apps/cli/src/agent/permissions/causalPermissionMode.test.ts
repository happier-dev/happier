import { describe, expect, it } from 'vitest';

import { resolveCausalPermissionMode } from './causalPermissionMode';

describe('resolveCausalPermissionMode', () => {
  it('fails closed when a causal-authority field is supplied but is not a strict authority value', () => {
    expect(resolveCausalPermissionMode({
      currentPermissionMode: 'yolo',
      context: { causalPermissionAuthority: null } as never,
    })).toEqual({
      ok: false,
      reason: 'causal_permission_authority_invalid',
    });
  });

  it('preserves legacy behavior only when the causal-authority field is absent', () => {
    expect(resolveCausalPermissionMode({
      currentPermissionMode: 'yolo',
      context: {},
    })).toEqual({
      ok: true,
      authority: 'legacy',
      effectiveMode: 'yolo',
    });
  });
});
