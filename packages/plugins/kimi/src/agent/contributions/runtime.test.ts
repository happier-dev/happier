import { describe, expect, it } from 'vitest';

import { KIMI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Kimi agent runtime contribution', () => {
  it('leaves spawn prerequisites to the generation-owned activation hook', () => {
    expect(KIMI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('daemonSpawnHooks');
  });
});
