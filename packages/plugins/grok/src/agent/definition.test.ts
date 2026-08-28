import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { GROK_PREFLIGHT_SESSION_CONTROLS } from './preflight/models.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

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
    expect(AGENT_DEFINITION).not.toHaveProperty('runtimeContributions.agentCatalogEntry');
    expect(AGENT_DEFINITION).not.toHaveProperty('authProbeConfig');
    expect(AGENT_DEFINITION).not.toHaveProperty('localCli');
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
    expect(AGENT_DEFINITION.modelConfig).not.toHaveProperty('acpModelConfigOptionId');
  });

  it('projects its catalog identity through the public Agent declaration', async () => {
    expect(PLUGIN_MANIFEST.contributes.agents).toContainEqual(
      expect.objectContaining({ id: 'grok' }),
    );
    const models = await GROK_PREFLIGHT_SESSION_CONTROLS.models?.parseOutput?.({
      ok: true,
      stdout: 'Available models:\ngrok-4\n',
      stderr: '',
      exitCode: 0,
    });

    expect(models).toEqual([{ id: 'grok-4', name: 'Grok 4' }]);
  });
});
