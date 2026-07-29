import { describe, expect, it } from 'vitest';

import { ScmHostingProviderContributionSchema } from './scmHostingProviders.js';

describe('SCM hosting-provider plugin contribution schema', () => {
  it('accepts the strict SCM-domain descriptor and structured auth-service reference', () => {
    expect(ScmHostingProviderContributionSchema.parse({
      id: 'acme-forge',
      title: { key: 'plugin.acme.title', fallback: 'Acme Forge' },
      description: 'Acme-hosted repositories.',
      kind: 'acme',
      capabilities: ['detect', 'clone', 'pullRequest'],
      authService: { pluginId: 'com.acme.accounts', localId: 'acme' },
      metadata: { tier: 'enterprise', hosted: true },
    })).toEqual({
      id: 'acme-forge',
      title: { key: 'plugin.acme.title', fallback: 'Acme Forge' },
      description: 'Acme-hosted repositories.',
      kind: 'acme',
      capabilities: ['detect', 'clone', 'pullRequest'],
      authService: { pluginId: 'com.acme.accounts', localId: 'acme' },
      metadata: { tier: 'enterprise', hosted: true },
    });
  });

  it('rejects retired transport, URL-policy, and credential materialization fields', () => {
    expect(ScmHostingProviderContributionSchema.safeParse({
      id: 'acme-forge',
      title: 'Acme Forge',
      kind: 'acme',
      capabilities: ['detect'],
      displayName: 'Acme Forge',
      baseUrl: 'https://forge.example',
      remoteHostMatchers: { exactHosts: ['forge.example'] },
      urlSafety: { allowedSchemes: ['https:'] },
      auth: { materializationKinds: ['token'] },
    }).success).toBe(false);
  });

  it('requires at least one unique declared operation', () => {
    const base = {
      id: 'acme-forge',
      title: 'Acme Forge',
      kind: 'acme',
    };

    expect(ScmHostingProviderContributionSchema.safeParse({
      ...base,
      capabilities: [],
    }).success).toBe(false);
    expect(ScmHostingProviderContributionSchema.safeParse({
      ...base,
      capabilities: ['detect', 'detect'],
    }).success).toBe(false);
  });
});
