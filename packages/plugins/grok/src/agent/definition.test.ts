import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './definition.js';
import { GROK_AGENT_RUNTIME_CONTRIBUTION } from './contributions/runtime.js';

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
    const models = await catalogContribution.preflightSessionControls.probeModelsRaw({
      // This is the process-execution boundary owned by the preflight contribution.
      exec: {
        systemTools: { resolve: async () => ({ executable: 'grok' }) },
        run: async () => ({
          termination: { observed: { kind: 'exit', exitCode: 0 } },
          stdout: new TextEncoder().encode('Available models:\ngrok-4\n'),
          stderr: new Uint8Array(),
        }),
      } as unknown as Parameters<typeof catalogContribution.preflightSessionControls.probeModelsRaw>[0]['exec'],
      cwd: '/workspace',
      timeoutMs: 250,
    });

    expect(models).toEqual([{ id: 'grok-4', name: 'Grok 4' }]);
  });
});
