import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, FeaturesResponseSchema,
  ProviderConnectionIdSchema, ProviderContributionV1Schema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createProviderOperationLifetime } from '../operationLifetime';
import { admitRuntimeProviderSavedSecret } from './runtimeCredential';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function featuresResponse() {
  return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} })),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function costAdmission() {
  const connectionId = ProviderConnectionIdSchema.parse('pc_cost');
  const ref = 'happier:shared-secret:v1:bob-provider';
  const providerSettings = { ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{ v: 1 as const, id: connectionId, role: 'default' as const,
      source: { kind: 'contribution' as const, contributionKey: 'acme.gateway/gateway' }, deployment: { kind: 'external' as const },
      displayName: 'Gateway', displayNameMode: 'automatic' as const, revision: 0, createdAt: 1, updatedAt: 1 }],
    secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: ref }, byMachineId: {} } } };
  const snapshot = { source: 'network' as const, settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1,
    settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('cost-token') };
  const definition = ProviderContributionV1Schema.parse({ v: 1, id: 'gateway', name: 'Gateway', kind: 'cloud',
    endpointTemplates: [{ id: 'main', protocol: 'openai-responses', baseUrl: 'https://gateway.test', publicHeaders: {}, capabilities: {
      streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
    catalog: { source: 'manual', manualModelPolicy: 'allowed' } });
  const admission = { connection: { connectionId, machineId: 'machine',
    authorization: { authorized: true, grantKind: 'account', grantFingerprint: 'grant', grantConfirmedAt: 1 },
    deployment: { kind: 'external' as const }, source: { kind: 'contribution' as const, contributionKey: 'acme.gateway/gateway',
      pluginId: 'acme.gateway', provenance: 'external' as const, definition } },
    providerSettings, snapshot, lifetime: createProviderOperationLifetime({}) } as const;
  return { admission, ref };
}

it('reads shared material once per Provider admission while retaining history recovery and observing rotation', async () => {
  const { admission, ref } = costAdmission();
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'cost-owner' })).toString('base64url')}.signature`;
  const snapshot = { ...admission.snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    rawSettings: {} };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null }, snapshot,
    serverHttpBaseUrl: 'https://cost-home.test', isCurrent: async () => true });
  const calls: { path: string; params: unknown }[] = [];
  const unexpected: string[] = [];
  let value = 'dummy-cost-first';
  let access = true;
  const material = { resourceId: 'bob-provider', encryptionMode: 'plain', recipientEnvelope: null,
    entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Cost key', kind: 'apiKey',
      ownerAccountId: 'cost-owner', revision: 1, materialStatus: 'ready',
      capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'bob-provider', mode: 'plain',
      content: { v: 1, name: 'Cost key', kind: 'apiKey', value } }) };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(featuresResponse());
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, params: config?.params ?? null });
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: access ? [{ ...material,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'bob-provider', mode: 'plain',
        content: { v: 1, name: 'Cost key', kind: 'apiKey', value } }) }] : [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    if (path === '/v1/account/entity-rows/provider-connections' || path === '/v1/account/entity-rows/prompt-library/registry-sources')
      return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
      complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
    if (path === '/v1/account/entity-rows/profiles/reference-guard') return { status: 200, data: { status: 'ready', revision: 1 } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    unexpected.push(path); throw new Error(`Unexpected cost fixture route ${path}`);
  });
  for (const rotatedValue of ['dummy-cost-first', 'dummy-cost-rotated']) {
    value = rotatedValue;
    calls.length = 0;
    const currentSnapshot = operationContext.readSnapshot();
    if (!currentSnapshot) throw new Error('Expected captured Account');
    const result = await admitRuntimeProviderSavedSecret({ ...admission, snapshot: currentSnapshot, operationContext,
      getAccountSettingsSnapshot: operationContext.readSnapshot });
    if (!result.ok) throw new Error(`Provider admission failed: ${result.error.code}`);
    expect(createSavedSecretMaterializerFromSnapshotV1(result.snapshot, { isCurrent: () => true }).resolve(ref))
      .toMatchObject({ status: 'ready', value: rotatedValue });
    expect(unexpected).toEqual([]);
    expect(calls.filter(call => call.path === '/v1/account/saved-secrets/resources/materials')).toHaveLength(1);
    expect(operationContext.readSnapshot()?.savedSecretLegacyImport).toMatchObject({ status: 'complete' });
  }
  access = false;
  calls.length = 0;
  const currentSnapshot = operationContext.readSnapshot();
  if (!currentSnapshot) throw new Error('Expected captured Account');
  expect(await admitRuntimeProviderSavedSecret({ ...admission, snapshot: currentSnapshot, operationContext,
    getAccountSettingsSnapshot: operationContext.readSnapshot })).toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
  expect(calls.filter(call => call.path === '/v1/account/saved-secrets/resources/materials')).toHaveLength(1);
});
