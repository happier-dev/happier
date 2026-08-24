import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { KIRO_AGENT_RUNTIME_CONTRIBUTION as catalogContribution } from './catalog.js';
import { KIRO_AGENT_RUNTIME_CONTRIBUTION as legacyRuntimeContribution } from './runtime.js';

describe('Kiro agent catalog contribution', () => {
  it('keeps the static catalog leaf independent from the legacy runtime entrypoint', () => {
    const catalogSource = readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8');

    expect(catalogSource).not.toContain("from './runtime");
  });

  it('preserves the legacy contribution identity and CLI auth result', async () => {
    expect(catalogContribution).toBe(legacyRuntimeContribution);

    await expect(catalogContribution.cliAuth.detectAuthStatus({
      runCommand: async () => ({
        ok: true,
        stdout: '{"email":"kiro@example.com"}',
        stderr: '',
        exitCode: 0,
      }),
    })).resolves.toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'kiro@example.com',
    });
  });
});
