import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema } from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import { buildLegacyProfileMigrationContext } from './buildContext';
import { authorizeLegacyProfileMigrationContext } from './authorizeContext';

const contributionKey = 'happier.provider.deepseek/deepseek';
const contribution = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'frontier',
  endpointTemplates: [{
    id: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'supported',
      statefulResponses: 'unknown',
      reasoningControls: 'unknown',
    },
  }],
  credential: {
    kind: 'apiKey',
    slotId: 'apiKey',
    required: true,
    transports: [{
      id: 'key',
      protocols: ['anthropic'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
    }],
  },
  catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
  legacyProfileMigrations: [{
    sourceProfileId: 'deepseek',
    credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
    migratedEnvironmentVariables: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://api.deepseek.com/anthropic' }],
    retainedEnvironmentVariables: [],
  }],
});

const resolvedContribution = {
  provenance: 'first_party',
  source: { kind: 'bundled' },
  pluginId: 'happier.provider.deepseek',
  identity: { pluginId: 'happier.provider.deepseek', localId: 'deepseek' },
  definition: contribution,
} as unknown as ResolvedProviderContribution;

function baseContext(rawSettings: Readonly<Record<string, unknown>>) {
  return buildLegacyProfileMigrationContext({
    rawSettings,
    providersByContributionKey: new Map([[contributionKey, resolvedContribution]]),
    allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc_deepseek' },
    migratedAt: 20,
  });
}

describe('authorizeLegacyProfileMigrationContext', () => {
  it('adds a fingerprint-bound account grant only after canonical public DNS resolution', async () => {
    const rawSettings = { favoriteProfiles: ['deepseek'] };
    const resolveAddresses = vi.fn(async () => ['8.8.8.8']);
    const context = await authorizeLegacyProfileMigrationContext({
      rawSettings,
      context: baseContext(rawSettings),
      providersByContributionKey: new Map([[contributionKey, resolvedContribution]]),
      machineId: 'machine_a',
      resolveAddresses,
    });

    expect(resolveAddresses).toHaveBeenCalledWith('api.deepseek.com');
    expect(context.candidates[0]).toMatchObject({
      kind: 'connection',
      connection: { id: 'pc_deepseek' },
      accountGrant: {
        v: 1,
        connectionId: 'pc_deepseek',
        confirmedAt: 20,
        connectionSecurityFingerprint: expect.stringMatching(/^connection-security:v1:/),
      },
    });
  });

  it.each([
    ['loopback', ['127.0.0.1']],
    ['private', ['192.168.1.10']],
    ['split horizon', ['8.8.8.8', '10.0.0.4']],
    ['unresolved', []],
  ])('does not auto-grant a %s endpoint', async (_label, addresses) => {
    const rawSettings = { favoriteProfiles: ['deepseek'] };
    const context = await authorizeLegacyProfileMigrationContext({
      rawSettings,
      context: baseContext(rawSettings),
      providersByContributionKey: new Map([[contributionKey, resolvedContribution]]),
      machineId: 'machine_a',
      resolveAddresses: async () => addresses,
    });

    expect(context.candidates[0]).not.toHaveProperty('accountGrant');
  });

  it('retains an edited default winner as a pending conflict without binding or granting its endpoint', async () => {
    const rawSettings = {
      favoriteProfiles: ['deepseek'],
      secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'saved_secret_old' } },
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
          v: 1,
          id: 'pc_existing',
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: 'DeepSeek',
          displayNameMode: 'automatic',
          endpointOverrides: [{ endpointTemplateId: 'anthropic', baseUrl: 'https://edited.example/v1' }],
          revision: 1,
          createdAt: 1,
          updatedAt: 2,
        }],
      },
    };
    const context = await authorizeLegacyProfileMigrationContext({
      rawSettings,
      context: baseContext(rawSettings),
      providersByContributionKey: new Map([[contributionKey, resolvedContribution]]),
      machineId: 'machine_a',
      resolveAddresses: async () => ['8.8.8.8'],
    });

    expect(context.candidates).toEqual([]);
    expect(context.pendingCustomProfileIds).toEqual([]);
    expect(context.pendingConflicts).toEqual([
      expect.objectContaining({
        sourceProfileId: 'deepseek',
        existingConnectionId: 'pc_existing',
        kinds: ['edited_default_connection'],
      }),
    ]);
    expect(JSON.stringify(context.pendingConflicts)).not.toContain('saved_secret_old');
  });

  it('persists a redacted typed conflict when a default winner has a different credential binding', async () => {
    const rawSettings = {
      favoriteProfiles: ['deepseek'],
      secretBindingsByProfileId: { deepseek: { DEEPSEEK_AUTH_TOKEN: 'saved_secret_legacy' } },
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
          v: 1, id: 'pc_existing',
          source: { kind: 'contribution', contributionKey },
          role: 'default', displayName: 'DeepSeek', displayNameMode: 'automatic',
          revision: 0, createdAt: 1, updatedAt: 1,
        }],
        secretBindingsByConnectionId: { pc_existing: { account: { apiKey: 'saved_secret_existing' } } },
      },
    };
    const context = await authorizeLegacyProfileMigrationContext({
      rawSettings,
      context: baseContext(rawSettings),
      providersByContributionKey: new Map([[contributionKey, resolvedContribution]]),
      machineId: 'machine_a',
      resolveAddresses: async () => ['8.8.8.8'],
    });

    expect(context.candidates).toEqual([]);
    expect(context.pendingConflicts).toEqual([
      expect.objectContaining({
        sourceProfileId: 'deepseek',
        existingConnectionId: 'pc_existing',
        kinds: ['credential_binding'],
      }),
    ]);
    const serialized = JSON.stringify(context.pendingConflicts);
    expect(serialized).not.toContain('saved_secret_legacy');
    expect(serialized).not.toContain('saved_secret_existing');
  });

  it('safely reuses a semantically identical pre-existing default connection', async () => {
    const rawSettings = {
      favoriteProfiles: ['deepseek'],
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{
          v: 1,
          id: 'pc_existing',
          source: { kind: 'contribution', contributionKey },
          role: 'default',
          displayName: 'Renamed by user',
          displayNameMode: 'custom',
          revision: 2,
          createdAt: 1,
          updatedAt: 3,
        }],
      },
    };
    const context = await authorizeLegacyProfileMigrationContext({
      rawSettings,
      context: baseContext(rawSettings),
      providersByContributionKey: new Map([[contributionKey, resolvedContribution]]),
      machineId: 'machine_a',
      resolveAddresses: async () => ['8.8.8.8'],
    });

    expect(context.pendingCustomProfileIds).toEqual([]);
    expect(context.candidates).toEqual([
      expect.objectContaining({
        kind: 'connection',
        connection: expect.objectContaining({ id: 'pc_existing', displayName: 'Renamed by user' }),
        accountGrant: expect.objectContaining({ connectionId: 'pc_existing' }),
      }),
    ]);
  });
});
