import axios from 'axios';
import {
  AccountSettingsSchema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  FeaturesResponseSchema,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
  splitProviderSettingsV1,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import {
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { hydrateSavedSecretCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';

import {
  materializeProviderConnectionDirectCredential,
  resolveAdmittedProviderConnectionDirectSourceSnapshot,
} from './providerConnectionSource';

// System boundaries only: the Home HTTP transport (catalog list and features)
// and the credentials file. The Provider source owner, Account Settings and the
// Saved Secret catalog owner are real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: Object.assign(Object.create(actual.default), { get: vi.fn() }) };
});

const persistenceMocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistenceMocks.readStoredCredentials,
}));

const token = 'source-account-token';
const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
const teamsEnabled = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
const connectionId = ProviderConnectionIdSchema.parse('pc_team_direct_source');
const contributionKey = 'acme.gateway/gateway';
const definition = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'gateway',
  name: 'External gateway',
  kind: 'cloud',
  endpointTemplates: [{
    id: 'responses',
    protocol: 'openai-responses',
    baseUrl: 'https://gateway.example/v1',
    capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported',
      statefulResponses: 'supported', reasoningControls: 'supported',
    },
  }],
  credential: {
    kind: 'apiKey',
    required: true,
    transports: [{
      id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'static',
    manualModelPolicy: 'allowed',
    staticModels: [{
      id: 'gateway-model',
      name: 'Gateway model',
      capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' },
    }],
  },
});
const contribution: ResolvedProviderContribution = {
  provenance: 'external',
  source: { kind: 'path' },
  pluginId: 'acme.gateway',
  identity: { pluginId: 'acme.gateway', localId: 'gateway' },
  definition,
};
const registry = {
  providersByContributionKey: new Map([[contributionKey, contribution]]),
  runtimeRegistryGeneration: 1,
  providerActivationOccurrenceIdsByPluginId: new Map([['acme.gateway', 'gateway-occurrence-1']]),
};
const dnsEvidenceByEndpointUrl = new Map([['https://gateway.example/v1', ['1.1.1.1']]]);
const resourceId = 'resource-provider-key';
const sharedRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
const sharedRow = {
  resourceId,
  encryptionMode: 'plain' as const,
  entry: {
    ref: sharedRef,
    source: 'shared_resource' as const,
    relationship: 'recipient' as const,
    name: 'Shared provider key',
    kind: 'apiKey' as const,
    ownerAccountId: 'owner-account',
    revision: 1,
    materialStatus: 'ready' as const,
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
  },
  storedContent: sealSavedSecretResourceStoredContentV1({
    resourceId,
    mode: 'plain',
    content: { v: 1, name: 'Shared provider key', kind: 'apiKey', value: 'shared-provider-value' },
  }),
  recipientEnvelope: null,
};

function sourceSettings() {
  const initial = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1, id: connectionId, source: { kind: 'contribution', contributionKey },
      role: 'default', displayName: 'Gateway', displayNameMode: 'automatic',
      revision: 1, createdAt: 1, updatedAt: 1,
    }],
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId, machineId: 'machine-a', providerSettings: initial,
    registry, dnsEvidenceByEndpointUrl,
  });
  if (resolution.status !== 'resolved') throw new Error('expected resolved connection');
  const { catalog, defaults } = splitProviderSettingsV1(ProviderSettingsV1Schema.parse({
    ...initial,
    accountGrants: [{
      v: 1, connectionId,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
    secretBindingsByConnectionId: {
      [connectionId]: { account: { apiKey: sharedRef } },
    },
  }));
  return {
    fingerprint: resolution.record.connectionSecurityFingerprint,
    settings: AccountSettingsSchema.parse({
      providerDefaultModelSelectionsByAgentTargetKeyV1: defaults,
    }),
    providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
  };
}

describe('Provider direct source admits its shared Saved Secret before preparation', () => {
  const { settings, fingerprint, providerConnectionsCatalog } = sourceSettings();
  const source = {
    v: 1 as const,
    kind: 'provider_connection' as const,
    connectionId,
    connectionSecurityFingerprint: fingerprint,
    credentialSlotId: 'apiKey' as const,
  };
  const resolve = () => resolveAdmittedProviderConnectionDirectSourceSnapshot({
    source,
    machineId: 'machine-a',
    expectedScopeKey: scopeKey,
    registry,
    dnsEvidenceByEndpointUrl,
    getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
  });

  beforeEach(async () => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.mocked(axios.get).mockReset();
    persistenceMocks.readStoredCredentials.mockReset();
    persistenceMocks.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(teamsEnabled), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings,
      providerConnectionsCatalog,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey,
    });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [sharedRow] } });
    await hydrateSavedSecretCatalog({ token, serverFeatures: teamsEnabled });
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.unstubAllGlobals();
  });

  it('refuses a revoked shared key whose AccountChange hint was missed', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });

    await expect(resolve()).resolves.toMatchObject({ ok: false });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('prepares from a still-authorized key without republishing an unchanged catalog', async () => {
    const publications = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(publications);
    try {
      const resolved = await resolve();
      if (!resolved.ok) throw new Error(`expected an admitted source snapshot, got ${resolved.error.code}`);
      await expect(materializeProviderConnectionDirectCredential({
        expected: resolved.snapshot,
        registry,
        dnsEvidenceByEndpointUrl,
        getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      })).resolves.toEqual({
        ok: true,
        credential: { kind: 'apiKey', value: 'shared-provider-value' },
      });
      expect(axios.get).toHaveBeenCalledTimes(2);
      // The reconciler's own admission cannot re-trigger the reconciler.
      expect(publications).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
