import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Auggie agent definition', () => {
  it('declares the provider-owned runtime contribution for model preflight', () => {
    expect(AGENT_DEFINITION.runtimeContributions?.agentCatalogEntry).toEqual({
      importName: 'AUGGIE_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/runtime',
    });
  });
});
