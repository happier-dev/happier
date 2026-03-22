import { describe, expect, it } from 'vitest';

import { AGENTS } from './catalog';

describe('backend CLI auth registry', () => {
  it('provides an explicit CLI auth spec loader for every catalog agent', () => {
    for (const [agentId, entry] of Object.entries(AGENTS)) {
      expect(entry.getCliAuthSpec, `${agentId} is missing getCliAuthSpec`).toBeTypeOf('function');
    }
  });
});
