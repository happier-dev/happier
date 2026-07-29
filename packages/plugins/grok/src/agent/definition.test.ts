import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';

describe('Grok native Agent definition', () => {
  it('keeps dynamic models and leaves CLI/auth authority to the native manifest', () => {
    expect(AGENT_DEFINITION).toMatchObject({
      id: 'grok',
      core: {
        sessionCapabilities: {
          sessionFork: { conversation: 'supported', fromMessage: 'supported' },
          sessionRollback: { conversation: 'supported' },
        },
        tools: {
          delivery: 'native_mcp',
          support: 'experimental',
        },
      },
      modelConfig: {
        supportsSelection: true,
        acpApplyBehavior: 'set_model',
        dynamicProbe: 'auto',
        defaultMode: null,
        allowedModes: [],
      },
    });
    expect(AGENT_DEFINITION.modelConfig).not.toHaveProperty('staticModels');
    expect(AGENT_DEFINITION.runtimeContributions).toEqual({
      agentCatalogEntry: {
        importName: 'GROK_AGENT_RUNTIME_CONTRIBUTION',
        source: './agent/contributions/runtime',
      },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('authProbeConfig');
    expect(AGENT_DEFINITION).not.toHaveProperty('localCli');
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
    expect(AGENT_DEFINITION.modelConfig).not.toHaveProperty('acpModelConfigOptionId');
  });
});
