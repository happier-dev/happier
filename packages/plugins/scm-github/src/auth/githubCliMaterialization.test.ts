import { describe, expect, it } from 'vitest';
import type { ConnectedAccountPortableReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { materializeGithubCredential } from './credentialMaterialization.js';

describe('GitHub CLI credential materialization', () => {
  it.each(['ghp_cli-classic-fixture', 'github_pat_cli-fixture', 'gho_cli-fixture'])('exports %s without Copilot-only restrictions', async token => {
    const context = { credentials: { get: async () => token } } as unknown as ConnectedAccountPortableReadContext;
    await expect(materializeGithubCredential({ kind: 'environment', keys: ['GH_TOKEN'] }, context))
      .resolves.toEqual({ kind: 'environment', env: { GH_TOKEN: token } });
  });

  it('refuses unavailable CLI credentials and undeclared destinations', async () => {
    const context = { credentials: { get: async () => null } } as unknown as ConnectedAccountPortableReadContext;
    await expect(materializeGithubCredential({ kind: 'environment', keys: ['GH_TOKEN'] }, context))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(materializeGithubCredential({ kind: 'environment', keys: ['GH_TOKEN', 'GITHUB_TOKEN'] }, context))
      .rejects.toMatchObject({ code: 'github_copilot_environment_unsupported' });
  });
});
