import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from '../definition.js';
import { KIMI_AGENT_RUNTIME_CONTRIBUTION as catalogContribution } from './catalog.js';
import { KIMI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Kimi agent runtime contribution', () => {
  it('leaves spawn prerequisites to the generation-owned activation hook', () => {
    expect(KIMI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('daemonSpawnHooks');
  });

  it('projects its catalog contribution from the static catalog leaf', () => {
    expect(AGENT_DEFINITION.runtimeContributions.agentCatalogEntry).toEqual({
      importName: 'KIMI_AGENT_RUNTIME_CONTRIBUTION',
      source: './agent/contributions/catalog',
    });
  });

  it('keeps the static catalog leaf independent from the legacy runtime entrypoint', () => {
    const catalogSource = readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8');

    expect(catalogSource).not.toContain("from './runtime");
  });

  it('preserves the legacy contribution identity and runtime preferences result', () => {
    expect(catalogContribution).toBe(KIMI_AGENT_RUNTIME_CONTRIBUTION);
    expect(catalogContribution.sessionRuntimePreferences.resolve({
      settings: {},
      processEnv: { HAPPIER_KIMI_ACP_SELECTOR: 'poll' },
    })).toEqual({
      environmentVariables: { HAPPIER_KIMI_ACP_SELECTOR: 'poll' },
    });
  });
});
