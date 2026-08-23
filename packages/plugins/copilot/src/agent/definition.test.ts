import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Copilot Agent definition', () => {
  it('does not project a catalog-runtime hook after its retired metadata is removed', () => {
    expect(AGENT_DEFINITION.runtimeContributions?.agentCatalogEntry).toBeUndefined();
  });
});
