import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, FeaturesResponseSchema,
  ProviderConnectionIdSchema, ProviderContributionV1Schema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createProviderOperationLifetime, ProviderOperationAbandonedError } from '../operationLifetime';
import { admitRuntimeProviderSavedSecret, resolveRuntimeProviderCredential, providerSavedSecretAdmissionError } from './runtimeCredential';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function featuresResponse() {
  return new Response(JSON.stringify(
    FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} }),
  ), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function gatewayAdmission({ custody, slotId, companion, signal }: Readonly<{
  custody: 'issued' | 'missing';
  slotId: 'apiKey' | 'managementKey';
  companion: 'none' | 'unused' | 'selected';
  signal?: AbortSignal;
}>) {
  const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
  const ref = 'happier:shared-secret:v1:bob-provider';
  const providerSettings = { ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{ v: 1 as const, id: connectionId, role: 'default' as const,
      source: { kind: 'contribution' as const, contributionKey: 'acme.gateway/gateway' },
      deployment: { kind: 'external' as const },
      displayName: 'Gateway', displayNameMode: 'automatic' as const, revision: 0, createdAt: 1, updatedAt: 1 }],
    secretBindingsByConnectionId: { [connectionId]: { account: { [slotId]: ref,
      ...(companion !== 'none' ? { unusedKey: 'happier:shared-secret:v1:revoked-unused' } : {}) }, byMachineId: {} } } };
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
    } }, { id: 'other', protocol: 'anthropic', baseUrl: 'https://gateway.test/anthropic', publicHeaders: {}, capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported',
    } }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } },
      { id: 'other-family', protocols: ['anthropic'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        additionalCredentials: [{ slotId: 'unusedKey', destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } }] }] },
    catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    usageSources: [{ id: 'credits', endpointTemplateId: 'main', path: '/credits', parser: 'example-credits',
      billingCredential: { slotId: 'managementKey', destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } }],
  });
  const admission = { connection: { connectionId, machineId: 'machine',
    authorization: { authorized: true, grantKind: 'account', grantFingerprint: 'grant', grantConfirmedAt: 1 },
    deployment: { kind: 'external' as const }, source: { kind: 'contribution' as const, contributionKey: 'acme.gateway/gateway',
      pluginId: 'acme.gateway', provenance: 'external' as const, definition } },
    providerSettings, snapshot, getAccountSettingsSnapshot: operationContext.readSnapshot,
    operationContext: custody === 'issued' ? operationContext : null,
    ...(companion === 'selected' ? { additionalCredentials: [{ slotId: 'unusedKey' }] } : {}),
    ...(slotId === 'managementKey' ? { usageSourceId: 'credits' } : {}),
    lifetime: createProviderOperationLifetime({ wallTimeMs: 10_000, ...(signal ? { signal } : {}) }),
  } as const;
  return { admission, alice, ref };
}

it.each([
  ['issued', 'apiKey', 'none'], ['missing', 'apiKey', 'none'], ['issued', 'managementKey', 'none'], ['missing', 'managementKey', 'none'],
  ['issued', 'apiKey', 'unused'], ['issued', 'apiKey', 'selected'],
] as const)('admits only the selected Provider shared secret through issued Bob private custody without publishing over Alice (%s, %s, %s)', async (custody, slotId, companion) => {
  const { admission, alice, ref } = gatewayAdmission({ custody, slotId, companion });
  // The authenticated feature projection uses Fetch, while material hydration uses Axios.
  const featureReads = vi.spyOn(globalThis, 'fetch').mockResolvedValue(featuresResponse());
  const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
    data: { resources: [{ resourceId: 'bob-provider', encryptionMode: 'plain', recipientEnvelope: null,
        entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Bob key', kind: 'apiKey',
          ownerAccountId: 'bob', revision: 1, materialStatus: 'ready',
          capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } },
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'bob-provider', mode: 'plain',
          content: { v: 1, name: 'Bob key', kind: 'apiKey', value: 'bob-private-key' } }),
      }] },
  });
  const result = await admitRuntimeProviderSavedSecret(admission);  if (companion === 'selected') {
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
    return;
  }
  if (custody === 'missing') {
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
    expect(reads).not.toHaveBeenCalled();
    expect(featureReads).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    return;
  }
  if (!result.ok) throw new Error(`Requester Provider admission failed: ${result.error.code}`);
  expect(result).toMatchObject({ ok: true, snapshot: { savedSecretResources: [{ resourceId: 'bob-provider', materialStatus: 'ready' }] } });
  expect(getActiveAccountSettingsSnapshot()).toBe(alice);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://bob-home.test/')
    && config?.headers?.Authorization === 'Bearer bob-token')).toBe(true);
  expect(featureReads.mock.calls).toEqual([['https://bob-home.test/v1/features/authenticated', expect.objectContaining({
    headers: { Authorization: 'Bearer bob-token' },
  })]]);
});

it.each([
  // Owner reason `reference_unavailable`: Home has not finished this recipient's material yet.
  ['Home preparing_encrypted_access', { status: 200, materialStatus: 'preparing_encrypted_access' }, 'provider_secret_unavailable', 'reference_unavailable'],
  // Untyped catalog failure: the Home could not be read, so nothing about the secret is known.
  ['Home catalog HTTP 500', { status: 500 }, 'provider_secret_unavailable', 'reference_unavailable'],
  // Typed non-ready reasons keep the owner projection's code and carry the owner's reason unchanged.
  ['Home access_removed', { status: 200, materialStatus: 'access_removed' }, 'provider_secret_missing', 'reference_forbidden'],
  ['Home deleted', { status: 200, materialStatus: 'deleted' }, 'provider_secret_missing', 'reference_deleted'],
  ['Home update_required', { status: 200, materialStatus: 'update_required' }, 'provider_secret_missing', 'reference_repair_required'],
  ['Home recipient_mode_unsupported', { status: 200, materialStatus: 'recipient_mode_unsupported' }, 'provider_secret_missing', 'reference_mode_incompatible'],
] as const)('refuses Provider admission with the Saved Secret owner outcome for %s before dispatch', async (_label, home, code, savedSecretReason) => {
  const { admission, alice, ref } = gatewayAdmission({ custody: 'issued', slotId: 'apiKey', companion: 'none' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(featuresResponse());
  vi.spyOn(axios, 'get').mockResolvedValue(home.status !== 200 ? { status: home.status, data: {} } : { status: 200,
    data: { resources: [{ resourceId: 'bob-provider', encryptionMode: 'plain', recipientEnvelope: null, storedContent: null,
      entry: { ref, source: 'shared_resource', relationship: 'recipient', name: 'Bob key', kind: 'apiKey',
        ownerAccountId: 'bob', revision: 1, materialStatus: home.materialStatus,
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } } }] } });

  const result = await admitRuntimeProviderSavedSecret(admission);

  expect(result).toMatchObject({ ok: false, error: { ...createProviderErrorV1(code, { connectionId: admission.connection.connectionId,
    machineId: 'machine' }), savedSecretReason } });
  expect(JSON.stringify(result)).not.toContain('bob-private-key');
  expect(getActiveAccountSettingsSnapshot()).toBe(alice);
});

it('keeps a cancelled Provider admission a cancellation, not a Saved Secret refusal', async () => {
  const controller = new AbortController();
  const { admission } = gatewayAdmission({ custody: 'issued', slotId: 'apiKey', companion: 'none', signal: controller.signal });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(featuresResponse());
  vi.spyOn(axios, 'get').mockImplementation(async () => { controller.abort(); return new Promise(() => {}); });

  await expect(admitRuntimeProviderSavedSecret(admission)).rejects.toBeInstanceOf(ProviderOperationAbandonedError);
});

it.each(['snapshot', 'materializer'] as const)('retains the %s failure through runtime credential refusal', async phase => {
  const { admission } = gatewayAdmission({ custody: 'issued', slotId: 'apiKey', companion: 'none' });
  const failure = Object.assign(new TypeError('Bearer private-fixture-value'), { code: 'ECONNREFUSED' });
  const result = await resolveRuntimeProviderCredential({
    credentialRef: { connectionId: admission.connection.connectionId, machineId: 'machine',
      reference: { kind: 'apiKey', secretId: 'secret', secretRecordFingerprint: 'fingerprint' },
      protocol: 'openai-responses', transport: { id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } },
    getAccountSettingsSnapshot: () => { if (phase === 'snapshot') throw failure; return admission.snapshot; },
    resolveSavedSecretMaterializer: async () => { throw failure; },
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'provider_secret_missing',
    failureCause: { errorClass: 'TypeError', errorCode: 'ECONNREFUSED' } } });
  expect(JSON.stringify(result)).not.toContain('private-fixture-value');
});

it('retains the unknown Home catalog cause alongside the Saved Secret owner reason', () => {
  expect(providerSavedSecretAdmissionError(Object.assign(new TypeError('private fixture'), { code: 'ECONNREFUSED' }),
    { connectionId: 'pc_gateway', machineId: 'machine' })).toMatchObject({ code: 'provider_secret_unavailable',
      savedSecretReason: 'reference_unavailable', failureCause: { errorClass: 'TypeError', errorCode: 'ECONNREFUSED' } });
});
