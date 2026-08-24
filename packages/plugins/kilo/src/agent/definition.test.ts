import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Kilo agent definition', () => {
  it('projects its catalog contribution from the static catalog leaf', () => {
    expect(AGENT_DEFINITION.runtimeContributions.agentCatalogEntry).toEqual({
      importName: 'KILO_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    });
  });
});
