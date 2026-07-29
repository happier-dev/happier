import { describe, expect, it } from 'vitest';

import { connectedAccountProjectionFamily } from './connectedAccounts';

function manualAuthentication(fields = [{
  id: 'token',
  title: 'Token',
  schema: { type: 'string' as const },
  secret: true,
}]) {
  return {
    defaultModeId: 'manual',
    modes: [{
      id: 'manual',
      kind: 'manual' as const,
      outcomeReconciliation: 'none' as const,
      fields,
    }],
  };
}

describe('connectedAccountProjectionFamily', () => {
  it('projects a non-SCM descriptor by its own qualified descriptor identity', () => {
    const projected = connectedAccountProjectionFamily.project({
      generation: 1,
      registry: {
        connectedAccountDescriptors: [{
          provenance: 'first_party',
          source: { kind: 'bundled' },
          pluginId: 'happier.agent.codex',
          definition: {
            id: 'openai-codex',
            title: 'Codex',
            authentication: {
              defaultModeId: 'oauth',
              modes: [{
                id: 'oauth',
                kind: 'oauthAuthorizationCode',
                pkce: 'required',
                outcomeReconciliation: 'providerCheck',
              }],
            },
          },
        }],
        scmHostingProviders: [],
        pluginDiagnosticsByPluginId: {},
      } as never,
    });

    expect(projected.entriesById['happier.agent.codex/openai-codex']).toEqual(
      expect.objectContaining({
        id: 'openai-codex',
        serviceId: 'openai-codex',
        pluginId: 'happier.agent.codex',
        authentication: {
          defaultModeId: 'oauth',
          modes: [{
            id: 'oauth',
            kind: 'oauthAuthorizationCode',
            pkce: 'required',
            outcomeReconciliation: 'providerCheck',
          }],
        },
      }),
    );
  });

  it('projects resolved descriptors without confidential adapters or executable hooks', () => {
    const projected = connectedAccountProjectionFamily.project({
      generation: 1,
      registry: {
        connectedAccountDescriptors: [{
          provenance: 'external', source: { kind: 'bundled' }, pluginId: 'happier.scm.hosting.bitbucket',
          definition: {
            id: 'bitbucket-account', title: 'Bitbucket account',
            authentication: manualAuthentication(),
          },
        }],
        scmHostingProviders: [{ id: 'bitbucket', pluginId: 'happier.scm.hosting.bitbucket', definition: { authService: 'bitbucket-account' } }],
        pluginDiagnosticsByPluginId: {},
      } as never,
    });
    expect(Object.values(projected.entriesById)).toEqual([
      expect.objectContaining({ id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.hosting.bitbucket' }),
    ]);
    expect(JSON.stringify(projected)).not.toContain('hostAdapter');
    expect(JSON.stringify(projected)).not.toContain('clientSecret');
    expect(JSON.stringify(projected)).not.toContain('function');
  });

  it('preserves localized copy, provenance, auth shape, capabilities, availability, and diagnostics', () => {
    const projected = connectedAccountProjectionFamily.project({
      generation: 1,
      registry: {
        connectedAccountDescriptors: [{
          provenance: 'external', source: { kind: 'installed' }, pluginId: 'happier.scm.hosting.bitbucket',
          definition: {
            id: 'bitbucket-account',
            title: { key: 'plugin.bitbucket.title', fallback: 'Bitbucket Cloud' },
            description: 'Connect repositories and pull requests',
            authentication: manualAuthentication([
              { id: 'identity', title: 'Email', schema: { type: 'string' }, secret: false },
              { id: 'token', title: 'API token', schema: { type: 'string' }, secret: true },
            ]),
            capabilities: ['scm.repositories'],
          },
        }],
        scmHostingProviders: [{ id: 'bitbucket', pluginId: 'happier.scm.hosting.bitbucket', definition: { authService: 'bitbucket-account' } }],
        pluginDiagnosticsByPluginId: {
          'happier.scm.hosting.bitbucket': [{ code: 'missing_runtime' }],
        },
      } as never,
    });

    expect(Object.values(projected.entriesById)).toEqual([{
      id: 'bitbucket-account',
      serviceId: 'bitbucket',
      pluginId: 'happier.scm.hosting.bitbucket',
      provenance: 'external',
      sourceKind: 'installed',
      title: { key: 'plugin.bitbucket.title', fallback: 'Bitbucket Cloud' },
      description: 'Connect repositories and pull requests',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [
            { id: 'identity', title: 'Email', schema: { type: 'string' }, secret: false },
            { id: 'token', title: 'API token', schema: { type: 'string' }, secret: true },
          ],
        }],
      },
      capabilities: ['scm.repositories'],
      availability: { state: 'blocked', reason: 'plugin_diagnostics' },
      diagnostics: ['missing_runtime'],
    }]);
  });

  it('resolves an auth-service relationship only within the descriptor plugin owner', () => {
    const projected = connectedAccountProjectionFamily.project({
      generation: 1,
      registry: {
        connectedAccountDescriptors: [{
          provenance: 'external', source: { kind: 'bundled' }, pluginId: 'acme.plugin.a',
          definition: {
            id: 'shared-account', title: 'Shared account',
            authentication: manualAuthentication(),
          },
        }],
        scmHostingProviders: [
          { id: 'bitbucket', pluginId: 'acme.plugin.b', definition: { authService: 'shared-account' } },
          { id: 'github', pluginId: 'acme.plugin.a', definition: { authService: 'shared-account' } },
        ],
        pluginDiagnosticsByPluginId: {},
      } as never,
    });

    expect(Object.values(projected.entriesById)).toEqual([
      expect.objectContaining({ serviceId: 'github', pluginId: 'acme.plugin.a' }),
    ]);
  });

  it('preserves same-local-id descriptors owned by different plugins', () => {
    const descriptor = (pluginId: string) => ({
      provenance: 'external' as const, source: { kind: 'bundled' as const }, pluginId,
      definition: {
        id: 'account', title: `${pluginId} account`,
        authentication: manualAuthentication(),
      },
    });
    const projected = connectedAccountProjectionFamily.project({
      generation: 1,
      registry: {
        connectedAccountDescriptors: [descriptor('acme.plugin.a'), descriptor('acme.plugin.b')],
        scmHostingProviders: [
          { id: 'github', pluginId: 'acme.plugin.a', definition: { authService: 'account' } },
          { id: 'bitbucket', pluginId: 'acme.plugin.b', definition: { authService: 'account' } },
        ],
        pluginDiagnosticsByPluginId: {},
      } as never,
    });

    expect(Object.values(projected.entriesById)).toEqual(expect.arrayContaining([
      expect.objectContaining({ serviceId: 'github', pluginId: 'acme.plugin.a' }),
      expect.objectContaining({ serviceId: 'bitbucket', pluginId: 'acme.plugin.b' }),
    ]));
    expect(Object.values(projected.entriesById)).toHaveLength(2);
  });

  it('honors an explicit qualified cross-plugin auth-service reference', () => {
    const projected = connectedAccountProjectionFamily.project({
      generation: 1,
      registry: {
        connectedAccountDescriptors: [{
          provenance: 'external', source: { kind: 'bundled' }, pluginId: 'acme.accounts',
          definition: {
            id: 'account', title: 'Account',
            authentication: manualAuthentication(),
          },
        }],
        scmHostingProviders: [{
          id: 'github', pluginId: 'acme.scm',
          definition: { authService: { pluginId: 'acme.accounts', localId: 'account' } },
        }],
        pluginDiagnosticsByPluginId: {},
      } as never,
    });

    expect(Object.values(projected.entriesById)).toEqual([
      expect.objectContaining({ serviceId: 'github', pluginId: 'acme.accounts' }),
    ]);
  });
});
