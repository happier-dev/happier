import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { GROK_AGENT_RUNTIME_CONTRIBUTION } from './contributions/runtime.js';
import { GROK_PREFLIGHT_SESSION_CONTROLS } from './preflight/models.js';

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
        source: './agent/contributions/catalog',
      },
    });
    expect(AGENT_DEFINITION).not.toHaveProperty('authProbeConfig');
    expect(AGENT_DEFINITION).not.toHaveProperty('localCli');
    expect(AGENT_DEFINITION).not.toHaveProperty('agentCliRuntime');
    expect(AGENT_DEFINITION.modelConfig).not.toHaveProperty('acpModelConfigOptionId');
  });

  it('keeps its static catalog leaf behavior-identical to the legacy runtime entrypoint', async () => {
    const catalogPath = fileURLToPath(new URL('./contributions/catalog.ts', import.meta.url));
    expect(existsSync(catalogPath)).toBe(true);
    if (!existsSync(catalogPath)) return;

    expect(readFileSync(catalogPath, 'utf8')).not.toContain('./runtime');

    const { GROK_AGENT_RUNTIME_CONTRIBUTION: catalogContribution } = await import('./contributions/catalog.js');

    expect(catalogContribution).toBe(GROK_AGENT_RUNTIME_CONTRIBUTION);
    expect(catalogContribution).toEqual({ agentId: 'grok' });
    const models = await GROK_PREFLIGHT_SESSION_CONTROLS.models?.parseOutput?.({
      ok: true,
      stdout: 'Available models:\ngrok-4\n',
      stderr: '',
      exitCode: 0,
    });

    expect(models).toEqual([{ id: 'grok-4', name: 'Grok 4' }]);
  });
});
