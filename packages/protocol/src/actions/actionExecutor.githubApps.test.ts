import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('createActionExecutor (managed GitHub Apps)', () => {
  it('routes a validated create intent through the single Home-domain family dependency', async () => {
    const homeDomainAction = vi.fn(async () => ({ registration: {
      id: 'registration-1',
      owner: { kind: 'team' as const, teamId: 'team-1' },
      githubHost: 'https://github.com',
      githubAppId: '44',
      githubClientId: 'Iv1.client',
      githubAppSlug: null,
      githubOwnerId: null,
      githubOwnerLogin: null,
      revision: 1,
      securityRevision: 1,
      state: 'draft' as const,
      secretHealth: { clientSecretConfigured: false, privateKeyConfigured: true, webhookSecretConfigured: false },
      lastVerifiedAt: null,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    } }));
    const executor = createActionExecutor({
      homeDomainAction,

    } as unknown as ActionExecutorDeps);
    const input = {
      owner: { kind: 'team' as const, teamId: 'team-1' },
      githubHost: 'https://github.com',
      githubAppId: '44',
      githubClientId: 'Iv1.client',
      secrets: { privateKey: 'private-key' },
    };

    await expect(executor.execute('identity.githubApps.create', input, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: true, result: { registration: { id: 'registration-1' } } });
    expect(homeDomainAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'identity.githubApps.create', input,
    }));
  });
});
