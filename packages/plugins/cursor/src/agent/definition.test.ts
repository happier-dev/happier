import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Cursor agent definition', () => {
  it('keeps Cursor Happier tool delivery on the shell bridge until native MCP is validated', () => {
    expect(AGENT_DEFINITION.core.tools).toEqual({
      delivery: 'shell_bridge',
      support: 'experimental',
    });
  });

  it('declares the provider-owned runtime contribution for model preflight', () => {
    expect(AGENT_DEFINITION.runtimeContributions?.agentCatalogEntry).toEqual({
      importName: 'CURSOR_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    });
  });
});
