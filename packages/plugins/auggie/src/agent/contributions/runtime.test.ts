import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AUGGIE_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';
import { AUGGIE_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';

describe('Auggie agent runtime contribution', () => {
  it('keeps public preflight command data out of the legacy catalog contribution', () => {
    expect(AUGGIE_AGENT_RUNTIME_CONTRIBUTION).toEqual({ agentId: 'auggie' });
    expect(AUGGIE_PREFLIGHT_SESSION_CONTROLS.models?.command).toEqual({
      toolId: 'auggie-cli',
      args: ['model', 'list', '--json'],
    });
  });

  it('keeps its static catalog leaf behavior-identical to the legacy runtime entrypoint', async () => {
    const catalogPath = fileURLToPath(new URL('./catalog.ts', import.meta.url));
    expect(existsSync(catalogPath)).toBe(true);
    if (!existsSync(catalogPath)) return;

    expect(readFileSync(catalogPath, 'utf8')).not.toContain('./runtime');

    const { AUGGIE_AGENT_RUNTIME_CONTRIBUTION: catalogContribution } = await import('./catalog.js');

    expect(catalogContribution).toBe(AUGGIE_AGENT_RUNTIME_CONTRIBUTION);
    expect(catalogContribution).toEqual({ agentId: 'auggie' });
  });
});
