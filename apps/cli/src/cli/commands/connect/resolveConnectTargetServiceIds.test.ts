import { describe, expect, it } from 'vitest';

import { resolveConnectTargetServiceIds } from './resolveConnectTargetServiceIds';

describe('resolveConnectTargetServiceIds', () => {
  it('maps GitHub connected accounts to the GitHub service id', () => {
    expect(resolveConnectTargetServiceIds('github')).toEqual(['github']);
  });

  it('returns no service ids for unknown targets', () => {
    expect(resolveConnectTargetServiceIds('unknown-target')).toEqual([]);
  });
});
