import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AUGGIE_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Auggie agent runtime contribution', () => {
  it('exports provider-owned model preflight controls', () => {
    expect(AUGGIE_AGENT_RUNTIME_CONTRIBUTION).toMatchObject({
      agentId: 'auggie',
      preflightSessionControls: {
        failureCacheStrategy: 'cooldown',
        cliModelsCommandArgs: ['model', 'list', '--json'],
        probeModelsRaw: expect.any(Function),
      },
    });
  });

  it('keeps its static catalog leaf behavior-identical to the legacy runtime entrypoint', async () => {
    const catalogPath = fileURLToPath(new URL('./catalog.ts', import.meta.url));
    expect(existsSync(catalogPath)).toBe(true);
    if (!existsSync(catalogPath)) return;

    expect(readFileSync(catalogPath, 'utf8')).not.toContain('./runtime');

    const { AUGGIE_AGENT_RUNTIME_CONTRIBUTION: catalogContribution } = await import('./catalog.js');

    expect(catalogContribution).toBe(AUGGIE_AGENT_RUNTIME_CONTRIBUTION);
    expect(catalogContribution.preflightSessionControls.cliModelsCommandArgs).toEqual(['model', 'list', '--json']);
    expect(catalogContribution.preflightSessionControls.probeModelsRaw)
      .toBe(AUGGIE_AGENT_RUNTIME_CONTRIBUTION.preflightSessionControls.probeModelsRaw);
  });
});
