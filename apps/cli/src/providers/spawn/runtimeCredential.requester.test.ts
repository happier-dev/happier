import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, FeaturesResponseSchema,
  ProviderConnectionIdSchema, ProviderContributionV1Schema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderOperationLifetime } from '../operationLifetime';
import { admitRuntimeProviderSavedSecret } from './runtimeCredential';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it('admits a Provider shared secret through Bob private custody without publishing over Alice', async () => {
  const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
  const ref = 'happier:shared-secret:v1:bob-provider';
  const providerSettings = { ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{ v: 1 as const, id: connectionId, role: 'default' as const,
      source: { kind: 'contribution' as const, contributionKey: 'acme.gateway/gateway' },
      displayName: 'Gateway', displayNameMode: 'automatic' as const, revision: 0, createdAt: 1, updatedAt: 1 }],
    secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: ref }, byMachineId: {} } } };
  const settings = AccountSettingsSchema.parse({});
  const snapshot = { source: 'network' as const, settings, settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('bob-token'),
    providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog: splitProviderSettingsV1(providerSettings).catalog } };
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken('alice-token') });
  const alice = getActiveAccountSettingsSnapshot();
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: { token: 'bob-token', encryption: null },
    snapshot, serverHttpBaseUrl: 'https://bob-home.test', isCurrent: async () => true });
  const definition = ProviderContributionV1Schema.parse({ v: 1, id: 'gateway', name: 'Gateway', kind: 'cloud',
    endpointTemplates: [{ id: 'main', protocol: 'openai-responses', baseUrl: 'https://gateway.test', publicHeaders: {}, capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported',
    } }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
    catalog: { source: 'manual', manualModelPolicy: 'allowed' } });
  // The authenticated feature projection uses Fetch, while material hydration uses Axios.
  const featureReads = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(
    FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} }),
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
    data: { resources: [{ resourceId: 'bob-provider', encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Bob key', kind: 'apiKey',
          ownerAccountId: 'bob', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'bob-provider', mode: 'plain',
          content: { v: 1, name: 'Bob key', kind: 'apiKey', value: 'bob-private-key' } }),
      }] },
  });
  const result = await admitRuntimeProviderSavedSecret({ connection: { connectionId, machineId: 'machine',
    authorization: { authorized: true, grantKind: 'account', grantFingerprint: 'grant', grantConfirmedAt: 1 },
    deployment: { kind: 'external' }, source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway',
      pluginId: 'acme.gateway', provenance: 'external', definition } },
    providerSettings, snapshot, getAccountSettingsSnapshot: operationContext.readSnapshot, operationContext,
    lifetime: createProviderOperationLifetime({ wallTimeMs: 10_000 }),
  });
  if (!result.ok) throw new Error(`Requester Provider admission failed: ${result.error.code}`);
  expect(result).toMatchObject({ ok: true, snapshot: { savedSecretResources: [{ resourceId: 'bob-provider', materialStatus: 'ready' }] } });
  expect(getActiveAccountSettingsSnapshot()).toBe(alice);
  expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://bob-home.test/')
    && config?.headers?.Authorization === 'Bearer bob-token')).toBe(true);
  expect(featureReads.mock.calls).toEqual([['https://bob-home.test/v1/features/authenticated', expect.objectContaining({
    headers: { Authorization: 'Bearer bob-token' },
  })]]);
});
