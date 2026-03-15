import { describe, expect, it } from 'vitest';

import { resolveConnectTargetServiceIds } from './resolveConnectTargetServiceIds';

describe('resolveConnectTargetServiceIds', () => {
  it('returns no service ids for unknown targets', () => {
    expect(resolveConnectTargetServiceIds('unknown-target')).toEqual([]);
  });
});
