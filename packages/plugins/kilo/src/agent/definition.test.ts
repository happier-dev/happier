import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Kilo agent definition', () => {
  it('does not retain a private catalog callback bag beside the public Agent declaration', () => {
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions.agentCatalogEntry');
  });
});
