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
import { hydrateSavedSecretCatalog } from "@/settings/secrets/savedSecretCatalogRead";
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { resolveProviderModelCompatibility } from '@/providers/catalog/compatibility';
import { prepareTeamCredentialNativeProviderSource, type TeamCredentialNativeProviderSourceAuthority } from './teamCredentialNativeProviderSource';

import {
  materializeProviderConnectionDirectCredential,
  resolveAdmittedProviderConnectionDirectSourceSnapshot,
  resolveAdmittedProviderConnectionSourceSnapshot,
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
    publicHeaders: { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' },
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
    await hydrateSavedSecretCatalog({ token });
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.unstubAllGlobals();
  });

  it.each(['direct', 'native'] as const)('admits the selected shared key from a cold catalog for %s preparation', async (mode) => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings, providerConnectionsCatalog,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    vi.mocked(axios.get).mockClear();

    const resolved = mode === 'direct' ? await resolve() : await resolveAdmittedProviderConnectionSourceSnapshot({
      source, machineId: 'machine-a', expectedScopeKey: scopeKey, registry, dnsEvidenceByEndpointUrl,
      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      endpoint: { endpointTemplateId: 'responses', protocol: 'openai-responses',
        credentialTransport: definition.credential!.transports[0]! },
    });
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) throw new Error(resolved.error.code);
    await expect(materializeProviderConnectionDirectCredential({ expected: resolved.snapshot,
      registry, dnsEvidenceByEndpointUrl, getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
    })).resolves.toEqual({ ok: true, credential: { kind: 'apiKey', value: 'shared-provider-value' } });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(vi.mocked(axios.get).mock.calls[0]?.[1]).toMatchObject({ params: { resourceIds: [resourceId] } });
  });

  it.each(['warm', 'cold', 'partial'] as const)('prepares private native metadata from a %s catalog, refreshes the selected key before rendering and refuses missed revocation', async (catalogState) => {
    if (catalogState !== 'warm') {
      resetActiveAccountSettingsSnapshotForTests();
      setActiveAccountSettingsSnapshot({ source: 'network', settings, providerConnectionsCatalog,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
        ...(catalogState === 'partial' ? { savedSecretCatalogState: 'ready' } : {}) });
    }
    const runtime = await createManagedRunLaunchFixture();
    try {
    const agentTargetKey = runtime.agentTargetKey;
    const adapter = readLeasedAgentProviderBindingAdapter({ lease: runtime.lease, agentId: runtime.agentId });
    if (!adapter) throw new Error('Expected registered Agent Provider adapter');
    let authority: TeamCredentialNativeProviderSourceAuthority = {
      resourceId: 'team-resource', resourceRevision: 7, sourceRevision: 'source-current',
      custodianAccountId: 'controller-account', enabled: true, source,
      deliveryPolicy: { preferredAllowedModes: ['vendor-native'] },
    };
    const current = getActiveAccountSettingsSnapshot()!;
    const resolution = resolveProviderConnectionForMachine({ connectionId, machineId: 'machine-a',
      providerSettings: readProviderSettingsForCli(current).settings, registry, dnsEvidenceByEndpointUrl });
    if (resolution.status !== 'resolved') throw new Error('Expected source');
    if (definition.catalog.source !== 'static') throw new Error('Expected a static catalog');
    const model = definition.catalog.staticModels[0]!;
    const compatibility = resolveProviderModelCompatibility({ record: resolution.record,
      providerSettings: readProviderSettingsForCli(current).settings, agentTargetKey,
      support: adapter.support,
      adapterVersion: adapter.adapter.adapterVersion, model });
    if (compatibility.result.status !== 'experimental') throw new Error('Expected experimental Gateway');
    expect(readProviderSettingsForCli(current).settings.experimentalBindingConfirmations).toEqual([]);
    let sourceReadFailure: Error | null = null;
    const input = { controllerAccountId: 'controller-account', controllerMachineId: 'machine-a', accountScopeKey: scopeKey,
      resource: authority, application: { agentTargetKey, implementationIdentity: contribution.identity,
        endpointTemplateId: 'responses', protocol: 'openai-responses' as const },
      binding: { selection: { v: 1 as const, ref: { agentTargetKey, providerConnectionId: connectionId,
        modelId: model.id }, updatedAt: 1 }, agentId: runtime.agentId, agentTargetKey, lease: runtime.lease },
      withRegistry: async <T,>(read: (value: typeof registry) => T | Promise<T>) => await read(registry),
      collectDnsEvidence: async () => dnsEvidenceByEndpointUrl, getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      readCurrentResource: async () => { if (sourceReadFailure) throw sourceReadFailure; return authority; }, signal: new AbortController().signal };
    const sourceFailureCause = { phase: 'provider.source_read', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    sourceReadFailure = Object.assign(new Error('private Home detail'), { failureCause: sourceFailureCause });
    await expect(prepareTeamCredentialNativeProviderSource(input)).resolves.toMatchObject({ ok: false,
      error: { code: 'provider_authorization_changed', failureCause: sourceFailureCause } });
    sourceReadFailure = null;
    const prepared = await prepareTeamCredentialNativeProviderSource(input);
    expect(prepared, prepared.ok ? 'prepared' : prepared.error.code).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error(prepared.error.code);
    try {
      const metadataReads = catalogState === 'warm' ? 1 : 2;
      expect(axios.get).toHaveBeenCalledTimes(metadataReads);
      expect(prepared.source.providerTicket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(prepared.source.endpoint.publicHeaders).toEqual({ 'http-referer': 'https://happier.dev', 'x-title': 'Happier' });
      expect(JSON.stringify(prepared.source)).not.toContain('shared-provider-value');
      const rendered = await prepared.source.readRenderedHeaders();
      expect(axios.get).toHaveBeenCalledTimes(metadataReads + 1);
      expect.soft(rendered).toEqual({ ok: true, headers: { authorization: 'Bearer shared-provider-value' } });
      expect(prepared.source.redact('Bearer shared-provider-value shared-provider-value')).toBe('[REDACTED] [REDACTED]');
      expect(await prepareTeamCredentialNativeProviderSource({ ...input, expectedProviderTicket: 'x'.repeat(43) }))
        .toMatchObject({ ok: false, error: { code: 'provider_authorization_changed' } });
      authority = { ...authority, sourceRevision: 'replaced-source' };
      expect(await prepared.source.readRenderedHeaders()).toMatchObject({ ok: true });
      expect(await prepareTeamCredentialNativeProviderSource(input)).toMatchObject({ ok: false,
        error: { code: 'provider_authorization_changed' } });
      authority = { ...authority, sourceRevision: 'source-current' };
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });
      expect(await prepared.source.readRenderedHeaders()).toMatchObject({ ok: false });
      authority = { ...authority, custodianAccountId: 'other-account' };
      expect(await prepareTeamCredentialNativeProviderSource(input)).toMatchObject({ ok: false,
        error: { code: 'provider_authorization_changed' } });
    } finally { await prepared.source.cleanup(); }
    expect(await prepared.source.readRenderedHeaders()).toMatchObject({ ok: false });
    } finally { await runtime.cleanup(); }
  });

  it('refuses a revoked shared key whose AccountChange hint was missed', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { resources: [] } });

    await expect(resolve()).resolves.toMatchObject({ ok: false });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('refuses an unbound source without reading Saved Secret material', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings,
      providerConnectionsCatalog: { ...providerConnectionsCatalog,
        catalog: { ...providerConnectionsCatalog.catalog, secretBindingsByConnectionId: {} } },
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    vi.mocked(axios.get).mockClear();
    await expect(resolve()).resolves.toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it.each(['missing', 'forbidden'] as const)('keeps a cold selected key denied when Home reports %s', async (reason) => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings, providerConnectionsCatalog,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    vi.mocked(axios.get).mockClear();
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: {
      resources: reason === 'missing' ? [] : [{ ...sharedRow, storedContent: null, entry: { ...sharedRow.entry,
        materialStatus: 'access_removed', capabilities: { ...sharedRow.entry.capabilities, use: false } } }],
    } });

    await expect(resolve()).resolves.toMatchObject({ ok: false, error: { code: 'provider_secret_missing' } });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('retains the typed transport cause when refreshing the selected shared key fails', async () => {
    const failureCause = { phase: 'provider.credential_resolution', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    vi.mocked(axios.get).mockRejectedValue(Object.assign(new Error('private source detail'), { failureCause }));
    await expect(resolve()).resolves.toMatchObject({ ok: false,
      error: { code: 'provider_secret_missing', failureCause },
    });
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
