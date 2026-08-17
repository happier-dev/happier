import { describe, expect, it } from 'vitest';

import {
  getConnectedServiceRegistryEntry,
  getQualifiedConnectedServiceRegistryEntry,
  getConnectedServiceRegistrySnapshot,
  installConnectedAccountDescriptorProjection,
} from './connectedServiceRegistry';
import type { ConnectedAccountDescriptorProjectionState } from './connectedAccountDescriptorProjection';

function manualAuthentication(fields: Array<Readonly<{
  id: string;
  title: string;
  secret: boolean;
}>>) {
  return {
    defaultModeId: 'manual',
    modes: [{
      id: 'manual',
      kind: 'manual' as const,
      outcomeReconciliation: 'none' as const,
      fields: fields.map((field) => ({
        ...field,
        schema: { type: 'string' as const, minLength: 1 },
      })),
    }],
  };
}

describe('connectedServiceRegistry', () => {
  const install = (
    descriptors: ConnectedAccountDescriptorProjectionState['descriptors'],
    status: ConnectedAccountDescriptorProjectionState['status'] = 'ready',
  ) => installConnectedAccountDescriptorProjection({
    scopeKey: 'server-a', status, descriptors, conflicts: [], errorReason: status === 'stale' ? 'transport' : null,
  });

  it('projects every declared authentication mode and preserves the default mode', () => {
    install([{
      id: 'multi-account',
      serviceId: 'multi-account',
      pluginId: 'acme.multi',
      provenance: 'external',
      sourceKind: 'installed',
      title: 'Multi account',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }, {
          id: 'browser',
          kind: 'oauthAuthorizationCode',
          pkce: 'required',
          outcomeReconciliation: 'providerCheck',
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          outcomeReconciliation: 'providerCheck',
        }],
      },
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    }]);

    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.multi', localId: 'multi-account',
    })).toMatchObject({
      executable: true,
      supportsToken: true,
      supportsOauth: true,
      defaultAuthenticationModeId: 'manual',
      authenticationModes: [
        expect.objectContaining({ id: 'manual', kind: 'manual' }),
        expect.objectContaining({ id: 'browser', kind: 'oauthAuthorizationCode' }),
        expect.objectContaining({ id: 'device', kind: 'oauthDeviceCode' }),
      ],
      oauthAddActionModes: ['browser', 'paste', 'device'],
    });
  });

  it('consumes projected plugin descriptors through the canonical registry', () => {
    install([{ id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled', title: 'Bitbucket account', authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]), capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }]);
    expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ connectCommand: 'happier connect bitbucket --token', supportsToken: true });
    install([]);
    expect(getConnectedServiceRegistryEntry('bitbucket')).toMatchObject({ supportsToken: false });
  });

  it('publishes immutable replacement entry snapshots for projection currentness', () => {
    install([{ id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled', title: 'Bitbucket account', authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]), capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }]);
    const previous = getConnectedServiceRegistrySnapshot();

    install([{ id: 'openai', serviceId: 'openai', pluginId: 'happier.voice.openai', provenance: 'first_party', sourceKind: 'bundled', title: 'OpenAI', authentication: manualAuthentication([{ id: 'token', title: 'API key', secret: true }]), capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }]);
    const current = getConnectedServiceRegistrySnapshot();

    expect(current.entries).not.toBe(previous.entries);
    expect(Object.isFrozen(current.entries)).toBe(true);
    expect(previous.entries.map((entry) => entry.serviceId)).toEqual(['bitbucket']);
    expect(current.entries.map((entry) => entry.serviceId)).toEqual(['openai']);
  });

  it('preserves rich blocked descriptor facts while keeping the service visible and non-executable', () => {
    const projected = {
      id: 'bitbucket-account', serviceId: 'bitbucket' as const, pluginId: 'happier.scm.forge.bitbucket', provenance: 'external' as const,
      sourceKind: 'bundled', title: { key: 'plugin.bitbucket.title', fallback: 'Bitbucket Cloud' },
      description: 'Connect repositories and pull requests',
      authentication: manualAuthentication([{ id: 'identity', title: 'Email', secret: false }, { id: 'token', title: 'API token', secret: true }]),
      capabilities: ['scm.repositories'], availability: { state: 'blocked' as const, reason: 'plugin_diagnostics' }, diagnostics: ['missing_runtime'],
    };
    install([projected]);

    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account',
    })).toMatchObject({
      executable: false,
      projectedDescriptor: projected,
      projectedTitle: projected.title,
      projectedDescription: projected.description,
      provenance: 'external',
      sourceKind: 'bundled',
      availability: { state: 'blocked', reason: 'plugin_diagnostics' },
      diagnostics: ['missing_runtime'],
      supportsOauth: false,
      supportsToken: false,
    });
  });

  it('retains last-known-good facts as stale and reports lifecycle without making them executable', () => {
    const projected = { id: 'bitbucket-account', serviceId: 'bitbucket' as const, pluginId: 'happier.scm.forge.bitbucket', provenance: 'external' as const, sourceKind: 'bundled', title: 'Bitbucket', authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]), capabilities: [], availability: { state: 'available' as const, reason: 'resolved' }, diagnostics: [] };
    install([projected], 'stale');

    expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'transport' });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account',
    })).toMatchObject({
      executable: false,
      projectionStatus: 'stale',
      projectedDescriptor: projected,
    });
  });

  it('keeps same-local-id services independent and reserves a legacy scalar for its generated owner', () => {
    const conflictedLeft = {
      id: 'github-account',
      serviceId: 'github' as const,
      pluginId: 'happier.scm.forge.github',
      provenance: 'first_party' as const,
      sourceKind: 'bundled',
      title: 'GitHub account',
      authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]),
      capabilities: [],
      availability: { state: 'available' as const, reason: 'resolved' },
      diagnostics: [],
    };
    const conflictedRight = {
      ...conflictedLeft,
      id: 'github',
      pluginId: 'acme.vertical-a',
      provenance: 'external' as const,
      title: 'Packed GitHub account',
    };
    const unrelated = {
      ...conflictedLeft,
      id: 'novel-cloud',
      serviceId: 'forge',
      pluginId: 'acme.vertical-a',
      provenance: 'external' as const,
      title: 'Novel Cloud',
    };
    const unrelatedBuiltIn = {
      ...conflictedLeft,
      id: 'anthropic',
      serviceId: 'anthropic',
      pluginId: 'happier.agent.claude',
      title: 'Anthropic API key',
    };

    installConnectedAccountDescriptorProjection({
      scopeKey: 'server-a',
      status: 'ready',
      descriptors: [conflictedLeft, conflictedRight, unrelated, unrelatedBuiltIn],
      conflicts: [],
      errorReason: null,
    });

    expect(getConnectedServiceRegistryEntry('github')).toMatchObject({
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.vertical-a', localId: 'github',
    })).toMatchObject({
      service: { pluginId: 'acme.vertical-a', localId: 'github' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.vertical-a', localId: 'novel-cloud',
    })).toMatchObject({
      service: { pluginId: 'acme.vertical-a', localId: 'novel-cloud' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.agent.claude', localId: 'anthropic',
    })).toMatchObject({
      service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
      executable: true,
      projectionStatus: 'ready',
    });

    installConnectedAccountDescriptorProjection({
      scopeKey: 'server-a',
      status: 'ready',
      descriptors: [conflictedLeft, unrelatedBuiltIn],
      conflicts: [],
      errorReason: null,
    });

    expect(getConnectedServiceRegistryEntry('github')).toMatchObject({
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' },
      executable: true,
      projectionStatus: 'ready',
    });
    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'acme.vertical-a', localId: 'novel-cloud',
    })).toBeNull();
  });

  it('does not infer executable built-in behavior before the daemon projection arrives', () => {
    install([]);

    expect(getConnectedServiceRegistryEntry('openai-codex')).toMatchObject({
      supportsOauth: false,
      supportsToken: false,
      executable: false,
    });
    expect(getConnectedServiceRegistryEntry('openai')).toMatchObject({
      connectCommand: 'happier connect openai',
      supportsToken: false,
      executable: false,
    });
    expect(getConnectedServiceRegistryEntry('gemini')).toMatchObject({
      supportsOauth: false,
      supportsToken: false,
      executable: false,
    });
  });

  it('makes the exact qualified bundled projection authoritative over the legacy built-in presentation', () => {
    const legacyEntry = getConnectedServiceRegistryEntry('openai');
    install([{
      id: 'openai',
      serviceId: 'openai',
      pluginId: 'happier.voice.openai',
      provenance: 'first_party',
      sourceKind: 'bundled',
      title: 'OpenAI API key',
      authentication: manualAuthentication([{ id: 'token', title: 'API key', secret: true }]),
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    }]);

    const projectedEntry = getConnectedServiceRegistryEntry('openai');
    expect(projectedEntry).not.toBe(legacyEntry);
    expect(projectedEntry).toMatchObject({
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      projectedDescriptor: expect.objectContaining({
        pluginId: 'happier.voice.openai',
        id: 'openai',
      }),
      defaultAuthenticationModeId: 'manual',
      authenticationModes: [
        expect.objectContaining({ id: 'manual', kind: 'manual' }),
      ],
    });
  });

  it('projects Bitbucket API-token setup metadata from descriptors', () => {
    install([{
      id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled',
      title: 'Bitbucket account', authentication: manualAuthentication([
        { id: 'identity', title: 'Email or username', secret: false },
        { id: 'token', title: 'API token', secret: true },
      ]),
      capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }]);
    const entry = getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account',
    })!;

    expect(entry.connectCommand).toBe('happier connect bitbucket --token');
    expect(entry.displayNameKey).toBeUndefined();
    expect(entry.supportsOauth).toBe(false);
    expect(entry.supportsToken).toBe(true);
    expect(entry.tokenKind).toBe('api-token');
    expect(entry.tokenSetupUrl).toBeUndefined();
    expect(entry.tokenIdentityPromptLabelKey).toBe('Email or username');
    expect(entry.tokenPromptLabelKey).toBe('API token');
  });

  it('does not claim an executable token action for unsupported multi-secret manual forms', () => {
    install([{
      id: 'complex-account', serviceId: 'bitbucket', pluginId: 'complex-plugin', provenance: 'external', sourceKind: 'bundled',
      title: 'Complex account', authentication: manualAuthentication([
        { id: 'client-secret', title: 'Client secret', secret: true },
        { id: 'access-token', title: 'Access token', secret: true },
      ]),
      capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }]);

    expect(getQualifiedConnectedServiceRegistryEntry({
      pluginId: 'complex-plugin', localId: 'complex-account',
    })).toMatchObject({
      supportsToken: false,
      connectCommand: 'happier connect bitbucket',
    });
  });

  it('keeps same-local-id services from different plugins independently qualified', () => {
    const left = {
      id: 'shared-service',
      serviceId: 'shared-service',
      pluginId: 'acme.connected.left',
      provenance: 'external' as const,
      sourceKind: 'installed',
      title: 'Left service',
      authentication: manualAuthentication([{ id: 'token', title: 'Token', secret: true }]),
      capabilities: [],
      availability: { state: 'available' as const, reason: 'resolved' },
      diagnostics: [],
    };
    const right = {
      ...left,
      pluginId: 'acme.connected.right',
      title: 'Right service',
    };

    install([left, right]);

    expect(getConnectedServiceRegistrySnapshot().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: { pluginId: 'acme.connected.left', localId: 'shared-service' },
        executable: true,
      }),
      expect.objectContaining({
        service: { pluginId: 'acme.connected.right', localId: 'shared-service' },
        executable: true,
      }),
    ]));
  });
});
