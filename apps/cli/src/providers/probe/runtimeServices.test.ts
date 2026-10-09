import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import * as persistence from '@/persistence';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  AccountSettingsSchema,
  FeaturesResponseSchema,
  sealSavedSecretResourceStoredContentV1,
  PROVIDER_ENDPOINT_SAFETY_LIMITS,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  createEmptyProviderRuntimeStateFileV1,
  splitProviderSettingsV1,
  formatSharedSavedSecretRefV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { hydrateSavedSecretCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createDeferred } from '@/testkit/async/deferred';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';

import { createRuntimeProviderServices } from './runtimeServices';
import {
  createProviderProbeHttpClient,
  type ProviderProbeTransportRequest,
} from './client';
import { PROVIDER_HEALTH_REFRESH_TTL_MS } from './scheduler';
import { createProviderLocalCatalogFallbackRunner } from './localCommand';

const temporaryPaths: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetActiveAccountSettingsSnapshotForTests();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const connectionId = ProviderConnectionIdSchema.parse('pc_static');
const contributionKey = 'acme.static/static';
const definition = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'static',
  name: 'Static provider',
  kind: 'cloud',
  endpointTemplates: [{
    id: 'chat',
    protocol: 'openai-chat',
    baseUrl: 'https://models.example/v1',
    capabilities: {
      streaming: 'supported', toolRoundTrips: 'unknown',
      statefulResponses: 'unknown', reasoningControls: 'unknown',
    },
  }],
  catalog: {
    source: 'static+probe',
    manualModelPolicy: 'allowed',
    staticModels: [{ id: 'static-a', name: 'Static A' }],
    probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'openai-models' }],
  },
});
const contribution: ResolvedProviderContribution = {
  provenance: 'external',
  source: { kind: 'path' },
  pluginId: 'acme.static',
  identity: { pluginId: 'acme.static', localId: 'static' },
  definition,
};
const registry = { providersByContributionKey: new Map([[contributionKey, contribution]]) };

function providerSnapshot(providerSettings: ProviderSettingsV1): ActiveAccountSettingsSnapshot {
  const { catalog, defaults } = splitProviderSettingsV1(providerSettings);
  return {
    source: 'cache',
    settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog },
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKeyForToken('provider-probe-snapshot-account'),
  };
}

function grantedSettings(providerRegistry = registry) {
  const base = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1, id: connectionId, source: { kind: 'contribution', contributionKey }, role: 'default',
      displayName: 'Static provider', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    }],
    manualModelsByConnectionId: {
      pc_static: [{ id: 'manual-a', name: 'Manual A', addedAt: 1 }],
    },
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId,
    machineId: 'machine-a',
    providerSettings: base,
    registry: providerRegistry,
    dnsEvidenceByEndpointUrl: new Map([['https://models.example/v1', ['1.1.1.1']]]),
  });
  if (resolution.status !== 'resolved') throw new Error('Expected resolved connection');
  return ProviderSettingsV1Schema.parse({
    ...base,
    accountGrants: [{
      v: 1,
      connectionId,
      connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      confirmedAt: 1,
    }],
  });
}

describe('runtime provider services', () => {
  it('spends the existing Provider operation deadline while opening a demanded Account catalog', async () => {
    vi.useFakeTimers();
    const credentials = { token: 'provider-catalog-deadline', encryption: null };
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {},
      settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token), providerConnectionsCatalog: { status: 'loading' } });
    const rowEntered = createDeferred<void>();
    const releaseRow = createDeferred<void>();
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/provider-connections') {
        rowEntered.resolve();
        await releaseRow.promise;
        return { status: 200, data: { status: 'deleted', revision: 2 } };
      }
      if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const history = emptyAccountSettingsHistoryCaptureResponse(path);
      if (history) return history;
      throw new Error(`Unexpected Provider deadline boundary: ${path}`);
    });
    const services = createRuntimeProviderServices({ machineId: 'machine-a', registry,
      featureGate: { isEnabled: () => true } });
    let observed: unknown;
    const pending = services.resolveCatalogContext({ connectionId, machineId: 'machine-a' }, undefined,
      { lifetime: { wallDeadlineAtMs: Date.now() + 25 } }).then(result => { observed = result; return result; });
    try {
      await rowEntered.promise;
      await vi.advanceTimersByTimeAsync(26);
      expect(observed).toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable' } });
    } finally {
      releaseRow.resolve();
      await pending;
    }
  });

  it('refuses a newly revoked shared Provider credential on saved probe without an AccountChange', async () => {
    const token = 'provider-probe-account';
    const resourceId = 'provider-probe-resource';
    const ref = formatSharedSavedSecretRefV1(resourceId);
    const credentialRegistry = { providersByContributionKey: new Map([[contributionKey, {
      ...contribution,
      definition: ProviderContributionV1Schema.parse({
        ...definition,
        credential: {
          kind: 'apiKey', slotId: 'apiKey', required: true,
          transports: [{ id: 'bearer', protocols: ['openai-chat'], uses: ['probe'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }],
        },
      }),
    }]]) };
    setActiveAccountSettingsSnapshot({
      ...providerSnapshot(ProviderSettingsV1Schema.parse({
        ...grantedSettings(credentialRegistry),
        secretBindingsByConnectionId: { [connectionId]: {
          account: { apiKey: formatSharedSavedSecretRefV1('unselected-resource') },
          byMachineId: { 'machine-a': { apiKey: ref } },
        } },
      })), source: 'network',
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token),
    });
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token, encryption: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features))));
    const materialResponse = (revision: number, value: string) => ({ status: 200, data: { resources: [{
      resourceId, encryptionMode: 'plain', recipientEnvelope: null,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId, mode: 'plain', content: { v: 1, name: 'Provider key', kind: 'apiKey', value },
      }),
      entry: {
        ref, source: 'shared_resource', relationship: 'recipient', name: 'Provider key', kind: 'apiKey',
        ownerAccountId: 'owner', revision, materialStatus: 'ready',
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
      },
    }] } });
    const get = vi.spyOn(axios, 'get').mockResolvedValue(materialResponse(1, 'revoked-value'));
    await hydrateSavedSecretCatalog({ token, serverFeatures: features });
    expect(getActiveAccountSettingsSnapshot()?.savedSecretResources).toMatchObject([{ resourceId, revision: 1 }]);
    get.mockClear();
    get.mockResolvedValue({ status: 200, data: { resources: [] } });
    const transport = vi.fn(async (_request: ProviderProbeTransportRequest) => ({
      status: 200, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'probe-a' }] })),
    }));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-credential-admission-'));
    temporaryPaths.push(happyHomeDir);
    const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine-a' });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', registry: credentialRegistry,
      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      resolveAddresses: async () => ['1.1.1.1'], featureGate: { isEnabled: () => true },
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      runtimeStore,
    });

    await expect(services.probe({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_secret_missing' },
    });
    expect(transport).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.savedSecretResources).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);

    get.mockResolvedValue(materialResponse(2, 'restored-value'));
    await expect(services.probe({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer restored-value' }),
    }));
    expect(get).toHaveBeenCalledTimes(2);
    get.mockResolvedValue(materialResponse(3, 'rotated-value'));
    await expect(services.probe({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer rotated-value' }),
    }));
    expect(get).toHaveBeenCalledTimes(3);
    await runtimeStore.update(() => createEmptyProviderRuntimeStateFileV1('machine-a'));
    await expect(services.scheduleDemandRefresh({ connectionId, machineId: 'machine-a' }, 'picker_open')).resolves.toBeNull();
    // Catalog and health are two requests in one admitted demand operation.
    expect(get).toHaveBeenCalledTimes(4);
    const current = getActiveAccountSettingsSnapshot()!;
    get.mockImplementationOnce(async () => {
      setActiveAccountSettingsSnapshot({ ...current, settingsVersion: current.settingsVersion + 1 });
      return materialResponse(3, 'rotated-value');
    });
    transport.mockClear();
    await expect(services.probe({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_authorization_changed' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('settles a picker read through the existing operation deadline when DNS never resolves', async () => {
    vi.useFakeTimers();
    try {
      const services = createRuntimeProviderServices({
        machineId: 'machine-a',
        registry,
        resolveAddresses: () => new Promise<readonly string[]>(() => {}),
        getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(grantedSettings()); return () => snapshot; })(),
        featureGate: { isEnabled: () => true },
      });
      const result = services.models({ connectionId, machineId: 'machine-a' });

      await vi.advanceTimersByTimeAsync(PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs);

      await expect(result).resolves.toMatchObject({
        status: 'error',
        error: { code: 'provider_endpoint_unavailable' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a contribution availability probe as the safe connection test when no catalog probe is declared', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-availability-'));
    temporaryPaths.push(happyHomeDir);
    const localConnectionId = ProviderConnectionIdSchema.parse('pc_local_availability');
    const localContributionKey = 'acme.local/local';
    const localDefinition = ProviderContributionV1Schema.parse({
      v: 1, id: 'local', name: 'Local', kind: 'local',
      endpointTemplates: [{
        id: 'native', protocol: 'ollama-native', localUrlCandidates: ['http://127.0.0.1:11434'],
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      discovery: {
        v: 1,
        listener: { executableBasenames: ['local-server'], defaultPorts: [11434] },
        availabilityProbe: { endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' },
      },
    });
    const localRegistry = { providersByContributionKey: new Map([[localContributionKey, {
      provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: 'acme.local',
      identity: { pluginId: 'acme.local', localId: 'local' },
      definition: localDefinition,
    }]]) };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: localConnectionId, source: { kind: 'contribution', contributionKey: localContributionKey },
        role: 'default', displayName: 'Local', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
      }],
    });
    const ungranted = resolveProviderConnectionForMachine({
      connectionId: localConnectionId, machineId: 'machine-a', providerSettings: base,
      registry: localRegistry, dnsEvidenceByEndpointUrl: new Map(),
    });
    if (ungranted.status !== 'resolved') throw new Error('Expected local connection');
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      machineGrants: [{
        v: 1, machineId: 'machine-a', connectionId: localConnectionId,
        endpointSetFingerprint: ungranted.record.endpointSetFingerprint,
        connectionSecurityFingerprint: ungranted.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    const transport = vi.fn(async (_request: ProviderProbeTransportRequest) => ({
      status: 200, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ models: [{ name: 'local-model' }] }), 'utf8'),
    }));
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', happyHomeDir, registry: localRegistry,
      resolveAddresses: async () => ['127.0.0.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['127.0.0.1'], transport }),
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
    });

    await expect(services.probe({ connectionId: localConnectionId, machineId: 'machine-a' }))
      .resolves.toMatchObject({ status: 'success', models: [{ id: 'local-model' }] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('fails closed before provider state, DNS, secrets, network, or runtime-state work when the root feature is disabled or absent', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-disabled-'));
    temporaryPaths.push(happyHomeDir);
    const resolveRegistry = vi.fn(async () => registry);
    const getAccountSettingsSnapshot = vi.fn(() => {
      throw new Error('provider settings must not be read while the feature is disabled');
    });
    const transport = vi.fn(async () => {
      throw new Error('network must not be reached while the feature is disabled');
    });
    const identity = { connectionId, machineId: 'machine-a' };

    for (const featureGate of [undefined, { isEnabled: () => false }] as const) {
      const services = createRuntimeProviderServices({
        machineId: 'machine-a',
        happyHomeDir,
        resolveRegistry,
        getAccountSettingsSnapshot,
        client: createProviderProbeHttpClient({
          resolveAddresses: async () => ['1.1.1.1'],
          transport,
        }),
        ...(featureGate ? { featureGate } : {}),
      });

      await expect(services.probe(identity)).resolves.toMatchObject({
        status: 'error', error: { code: 'provider_feature_disabled' },
      });
      await expect(services.models(identity)).resolves.toMatchObject({
        status: 'error', error: { code: 'provider_feature_disabled' },
      });
      await expect(services.probeDraft({
        kind: 'draft',
        draftConnectionId: ProviderConnectionIdSchema.parse('pc_draft_1'),
        machineId: 'machine-a',
        template: {
          v: 1,
          name: 'Draft',
          endpointTemplates: [{
            id: 'openai', protocol: 'openai-chat', baseUrl: 'https://models.example/v1',
            capabilities: {
              streaming: 'unknown', toolRoundTrips: 'unknown',
              statefulResponses: 'unknown', reasoningControls: 'unknown',
            },
          }],
          catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        },
        savedSecretId: null,
        actionNonce: 'draft-action-0001',
      })).resolves.toMatchObject({
        status: 'error', error: { code: 'provider_feature_disabled' },
      });
    }

    expect(resolveRegistry).not.toHaveBeenCalled();
    expect(getAccountSettingsSnapshot).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('drops queued saved work when the root feature is revoked before scheduler dispatch', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-revoked-queue-'));
    temporaryPaths.push(happyHomeDir);
    const settings = grantedSettings();
    let enabled = true;
    const transport = vi.fn(async () => {
      throw new Error('a revoked queued saved probe must not reach transport');
    });
    const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine-a' });
    const getAccountSettingsSnapshot = vi.fn((() => { const snapshot = providerSnapshot(settings); return () => snapshot; })());
    const resolveAddresses = vi.fn(async () => ['1.1.1.1']);
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      registry,
      runtimeStore,
      resolveAddresses,
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['1.1.1.1'],
        transport,
      }),
      getAccountSettingsSnapshot,
      featureGate: { isEnabled: () => enabled },
    });
    const scheduler = services.probeInfrastructure.scheduler;
    const scheduled = vi.spyOn(scheduler, 'runCatalog');
    const releases: Array<() => void> = [];
    const occupied = [0, 1, 2, 3].map((index) => scheduler.runCatalog(
      `occupied-${index}`,
      'manual_refresh',
      () => new Promise<Readonly<{ status: 'not_supported' }>>((resolve) => {
        releases.push(() => resolve({ status: 'not_supported' }));
      }),
      { unavailable: () => ({ status: 'not_supported' as const }) },
    ));
    await vi.waitFor(() => expect(releases).toHaveLength(4));

    const queued = services.probe({ connectionId, machineId: 'machine-a' });
    // DNS is the first admitted Provider operation. It is queued behind the
    // occupied catalog work, so no catalog request or resolver may start yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toHaveBeenCalledTimes(4);
    expect(resolveAddresses).not.toHaveBeenCalled();
    const settingsReadsAtAdmission = getAccountSettingsSnapshot.mock.calls.length;
    enabled = false;
    for (const release of releases.splice(0)) release();

    await expect(queued).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_feature_disabled' },
    });
    await expect(Promise.all(occupied)).resolves.toHaveLength(4);
    expect(getAccountSettingsSnapshot).toHaveBeenCalledTimes(settingsReadsAtAdmission);
    expect(resolveAddresses).not.toHaveBeenCalled();
    expect(scheduled).toHaveBeenCalledTimes(4);
    expect(transport).not.toHaveBeenCalled();
    expect(await runtimeStore.read()).toEqual(createEmptyProviderRuntimeStateFileV1('machine-a'));
  });

  it('detaches an aborted draft-probe caller while a second caller retains the shared transport', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-draft-scheduler-'));
    temporaryPaths.push(happyHomeDir);
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
    const transport = vi.fn(async () => {
      await transportGate;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'draft-model' }] }), 'utf8'),
      };
    });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      registry: { providersByContributionKey: new Map() },
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      getAccountSettingsSnapshot: (() => {
        const snapshot = providerSnapshot(ProviderSettingsV1Schema.parse(DEFAULT_PROVIDER_SETTINGS_V1));
        return () => snapshot;
      })(),
      featureGate: { isEnabled: () => true },
    });
    const request = {
      kind: 'draft' as const,
      draftConnectionId: ProviderConnectionIdSchema.parse('pc_draft_scheduler'),
      machineId: 'machine-a',
      template: {
        v: 1 as const,
        name: 'Draft scheduler',
        endpointTemplates: [{
          id: 'openai', protocol: 'openai-chat' as const, baseUrl: 'https://draft.example/v1',
          capabilities: {
            streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const,
            statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const,
          },
        }],
        catalog: {
          source: 'probe' as const, manualModelPolicy: 'allowed' as const,
          probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' as const }],
        },
      },
      savedSecretId: null,
      actionNonce: 'draft-action-coalesce-0001',
    };

    const firstController = new AbortController();
    const first = services.probeDraft(request, { signal: firstController.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const second = services.probeDraft(request);
    firstController.abort();
    releaseTransport();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        status: 'error', error: expect.objectContaining({ code: 'provider_endpoint_unavailable' }),
      }),
      expect.objectContaining({ status: 'success', models: [{ id: 'draft-model' }] }),
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('detaches an aborted saved-probe caller while a second caller retains the shared transport', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-saved-probe-cancellation-'));
    temporaryPaths.push(happyHomeDir);
    const settings = grantedSettings();
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
    const transport = vi.fn(async () => {
      await transportGate;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'probe-a' }] }), 'utf8'),
      };
    });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', happyHomeDir, registry,
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
    });
    const identity = { connectionId, machineId: 'machine-a' };
    const firstController = new AbortController();
    const first = services.probe(identity, 'manual_refresh', { signal: firstController.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    const second = services.probe(identity);

    firstController.abort();
    releaseTransport();

    await expect(first).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_endpoint_unavailable' },
    });
    await expect(second).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('keeps identical post-load work live for a current caller while a cancelled waiter gets typed unavailable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-model-load-scheduler-'));
    temporaryPaths.push(happyHomeDir);
    const settings = grantedSettings();
    let releaseTransport!: () => void;
    let transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
    const transport = vi.fn(async (request: ProviderProbeTransportRequest) => {
      await Promise.race([
        transportGate,
        new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('caller aborted shared refresh')), { once: true });
        }),
      ]);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'probe-a' }] }), 'utf8'),
      };
    });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', happyHomeDir, registry,
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const refreshInput = {
      connectionId,
      machineId: 'machine-a',
      modelId: 'probe-a',
      refreshFrontier: 'dispatch-a',
      ticket: { revision: 1 },
      scope: { lifetime: { wallDeadlineAtMs: Date.now() + PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs } },
    };
    const first = services.modelLoadCatalog.refresh({ ...refreshInput, signal: firstController.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const second = services.modelLoadCatalog.refresh({ ...refreshInput, signal: secondController.signal });
    const retryAfterAnotherDispatch = services.modelLoadCatalog.refresh({
      ...refreshInput,
      refreshFrontier: 'dispatch-b',
      signal: secondController.signal,
    });
    firstController.abort();
    releaseTransport();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await expect(Promise.all([first, second, retryAfterAnotherDispatch])).resolves.toEqual([
      expect.objectContaining({
        status: 'error',
        error: expect.objectContaining({ code: 'provider_endpoint_unavailable' }),
      }),
      expect.objectContaining({ status: 'success' }),
      expect.objectContaining({ status: 'success' }),
    ]);
    expect(transport).toHaveBeenCalledTimes(2);

    transportGate = Promise.resolve();
    await expect(services.modelLoadCatalog.refresh({
      ...refreshInput,
      signal: secondController.signal,
    })).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('does not confirm a model load from catalog work that started before that model mutation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-model-load-frontier-'));
    temporaryPaths.push(happyHomeDir);
    const settings = grantedSettings();
    const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine-a' });
    let releaseDemandRefresh!: () => void;
    const demandRefreshGate = new Promise<void>((resolve) => { releaseDemandRefresh = resolve; });
    let transportCall = 0;
    const transport = vi.fn(async () => {
      transportCall += 1;
      if (transportCall === 1) await demandRefreshGate;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ data: [{ id: 'probe-a' }] }), 'utf8'),
      };
    });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', happyHomeDir, registry,
      runtimeStore,
      resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
    });
    const identity = { connectionId, machineId: 'machine-a' };

    await expect(services.models(identity)).resolves.toMatchObject({ status: 'success' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const confirmation = services.modelLoadCatalog.refresh({
      ...identity,
      modelId: 'probe-a',
      refreshFrontier: 'dispatch-a',
      ticket: { revision: 1 },
      signal: new AbortController().signal,
      scope: { lifetime: { wallDeadlineAtMs: Date.now() + PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs } },
    });
    releaseDemandRefresh();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await confirmation;
  });

  it('owns identity-only probe and canonical merged model handlers', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-'));
    temporaryPaths.push(happyHomeDir);
    const settings = grantedSettings();
    const resolveAddresses = async () => ['1.1.1.1'];
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'probe-a' }] }), 'utf8'),
    }));
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      registry,
      resolveAddresses,
      client: createProviderProbeHttpClient({
        resolveAddresses,
        transport,
      }),
      createObservationId: () => 'observation-a',
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      featureGate: { isEnabled: () => true },
    });
    const identity = { connectionId, machineId: 'machine-a' };

    await expect(services.models(identity)).resolves.toMatchObject({
      status: 'success',
      models: [
        expect.objectContaining({ id: 'static-a' }),
        expect.objectContaining({ id: 'manual-a' }),
      ],
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    await expect(services.probe(identity)).resolves.toMatchObject({
      status: 'success', models: [{ id: 'probe-a' }],
    });
    await expect(services.models(identity)).resolves.toMatchObject({
      status: 'success', connectionRevision: settings.connections[0]?.revision,
      manualModelPolicy: 'allowed',
      models: [
        expect.objectContaining({ id: 'static-a', source: 'static', stale: false }),
        expect.objectContaining({ id: 'manual-a', source: 'manual', stale: false, visibility: 'visible' }),
        expect.objectContaining({ id: 'probe-a', source: 'probe', stale: false }),
      ],
    });
    await expect(services.models({ ...identity, machineId: 'machine-b' })).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_not_enabled_on_machine' },
    });

    const noAuthUnauthorized = createRuntimeProviderServices({
      machineId: 'machine-a',
      featureGate: { isEnabled: () => true },
      happyHomeDir,
      registry,
      resolveAddresses,
      client: createProviderProbeHttpClient({
        resolveAddresses,
        transport: async () => ({ status: 401, headers: {}, body: Buffer.alloc(0) }),
      }),
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
    });
    await expect(noAuthUnauthorized.probe(identity)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_probe_response_invalid' },
    });
  });

  it('projects one opaque probe-observation identity from exact request, authorization, and grant facts', async () => {
    const identityConnectionId = ProviderConnectionIdSchema.parse('pc_observation_identity');
    const identityContributionKey = 'acme.identity/identity';
    const token = 'provider-probe-observation-identity';
    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const resourceDataKey = new Uint8Array(32).fill(7);
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({
      token, encryption: { type: 'dataKey', machineKey, publicKey },
    });
    const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features))));
    const definitionForProbe = (path: string) => ProviderContributionV1Schema.parse({
      v: 1,
      id: 'identity',
      name: 'Identity provider',
      kind: 'cloud',
      endpointTemplates: [{
        id: 'chat',
        protocol: 'openai-chat',
        baseUrl: 'https://identity.example/v1',
        capabilities: {
          streaming: 'supported', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      credential: {
        kind: 'apiKey',
        required: true,
        transports: [{
          id: 'probe-bearer',
          protocols: ['openai-chat'],
          uses: ['probe'],
          destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
        }],
      },
      catalog: {
        source: 'probe',
        manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'chat', path, parser: 'openai-models' }],
      },
    });
    let activeDefinition = definitionForProbe('/models');
    const identityRegistry = { providersByContributionKey: new Map([[identityContributionKey, {
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId: 'acme.identity',
      identity: { pluginId: 'acme.identity', localId: 'identity' },
      definition: activeDefinition,
    }]]) };
    let connection = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1,
        id: identityConnectionId,
        source: { kind: 'contribution', contributionKey: identityContributionKey },
        role: 'default',
        displayName: 'Identity provider',
        displayNameMode: 'automatic',
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
    }).connections[0]!;
    let secretValue = 'secret-one';
    const savedSecretResource = () => ({ resourceId: 'secret-identity', ownerAccountId: 'owner-account',
      displayName: 'Identity API key', kind: 'apiKey' as const, encryptionMode: 'e2ee' as const,
      resourceDataKey: new Uint8Array(resourceDataKey),
      revision: secretValue === 'secret-one' ? 1 : 2, materialStatus: 'ready' as const,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'secret-identity', mode: 'e2ee',
        resourceDataKey, randomBytes: length => new Uint8Array(length).fill(secretValue === 'secret-one' ? 3 : 4),
        content: { v: 1, name: 'Identity API key', kind: 'apiKey', value: secretValue } }) });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (new URL(String(url)).pathname !== '/v1/account/saved-secrets/resources/materials') {
        throw new Error(`Unexpected observation-identity boundary: ${String(url)}`);
      }
      const resource = savedSecretResource();
      return { status: 200, data: { resources: [{
        resourceId: resource.resourceId,
        encryptionMode: 'e2ee',
        entry: {
          ref: formatSharedSavedSecretRefV1(resource.resourceId), source: 'shared_resource', relationship: 'recipient',
          name: resource.displayName, kind: resource.kind, ownerAccountId: resource.ownerAccountId,
          revision: resource.revision, materialStatus: 'ready',
          capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
        },
        storedContent: resource.storedContent,
        recipientEnvelope: {
          encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({
            dataKey: resourceDataKey, recipientPublicKey: publicKey,
            randomBytes: length => new Uint8Array(length).fill(13),
          })).toString('base64'),
          recipientContentPublicKeyFingerprint: 'identity-account-content-key',
        },
      }] } };
    });
    const dnsEvidence = new Map([
      ['https://identity.example/v1', ['1.1.1.1']],
      ['https://identity-override.example/v1', ['1.1.1.2']],
    ]);
    const buildSettings = (confirmedAt: number | null) => {
      const ungranted = ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [connection],
        secretBindingsByConnectionId: {
          [identityConnectionId]: { account: { apiKey: formatSharedSavedSecretRefV1('secret-identity') } },
        },
      });
      if (confirmedAt === null) return ungranted;
      const resolution = resolveProviderConnectionForMachine({
        connectionId: identityConnectionId,
        machineId: 'machine-a',
        providerSettings: ungranted,
        registry: identityRegistry,
        dnsEvidenceByEndpointUrl: dnsEvidence,
      });
      if (resolution.status !== 'resolved') throw new Error('Expected identity connection resolution');
      return ProviderSettingsV1Schema.parse({
        ...ungranted,
        accountGrants: [{
          v: 1,
          connectionId: identityConnectionId,
          connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
          confirmedAt,
        }],
      });
    };
    let settings = buildSettings(10);
    const transport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ id: 'model-a' }] }), 'utf8'),
    }));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-observation-identity-'));
    temporaryPaths.push(happyHomeDir);
    const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine-a' });
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      runtimeStore,
      resolveRegistry: async () => identityRegistry,
      resolveAddresses: async (hostname) => hostname === 'identity-override.example' ? ['1.1.1.2'] : ['1.1.1.1'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async (hostname) => hostname === 'identity-override.example' ? ['1.1.1.2'] : ['1.1.1.1'],
        transport,
      }),
      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      featureGate: { isEnabled: () => true },
    });
    const requestIdentity = { connectionId: identityConnectionId, machineId: 'machine-a' };
    let publishedSettings: ProviderSettingsV1 | undefined;
    let settingsVersion = 0;
    const publishSettings = () => {
      if (publishedSettings === settings) return;
      settingsVersion += 1;
      setActiveAccountSettingsSnapshot({ ...providerSnapshot(settings), source: 'network', settingsVersion,
        scopeKey: resolveAccountSettingsScopeKeyForToken(token) });
      publishedSettings = settings;
    };
    const readIdentity = async (): Promise<string> => {
      publishSettings();
      const result = await services.summary(requestIdentity);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'success',
        probeObservationIdentity: expect.stringMatching(/^probe-observation:v1:/u),
      });
      if (result.status !== 'success') throw new Error('Expected Provider summary');
      return result.probeObservationIdentity;
    };

    const initialIdentity = await readIdentity();
    const initialProviderSettings = settings;
    const initialAccountSettings = providerSnapshot(initialProviderSettings).settings;
    const initialSavedSecretResources = [savedSecretResource()];
    const initialRegistry = {
      providersByContributionKey: new Map(identityRegistry.providersByContributionKey),
    };
    const initialDnsEvidenceByEndpointUrl = new Map([
      ['https://identity.example/v1', ['1.1.1.1']],
    ]);
    const initialResolution = resolveProviderConnectionForMachine({
      ...requestIdentity,
      providerSettings: initialProviderSettings,
      registry: initialRegistry,
      dnsEvidenceByEndpointUrl: initialDnsEvidenceByEndpointUrl,
    });
    if (initialResolution.status !== 'resolved') {
      throw new Error('Expected the initial Provider connection resolution');
    }
    connection = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        ...connection,
        displayName: 'Renamed connection',
        displayNameMode: 'custom',
        revision: connection.revision + 1,
        updatedAt: 2,
      }],
    }).connections[0]!;
    settings = buildSettings(10);
    await expect(readIdentity()).resolves.toBe(initialIdentity);

    secretValue = 'secret-two';
    const rotatedSecretIdentity = await readIdentity();
    expect(rotatedSecretIdentity).not.toBe(initialIdentity);

    settings = buildSettings(null);
    publishSettings();
    await expect(services.summary(requestIdentity)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_connection_disabled' },
    });
    settings = buildSettings(20);
    const regrantedIdentity = await readIdentity();
    expect(regrantedIdentity).not.toBe(rotatedSecretIdentity);

    connection = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        ...connection,
        endpointOverrides: [{
          endpointTemplateId: 'chat',
          baseUrl: 'https://identity-override.example/v1',
        }],
        revision: connection.revision + 1,
        updatedAt: 3,
      }],
    }).connections[0]!;
    settings = buildSettings(30);
    const endpointIdentity = await readIdentity();
    expect(endpointIdentity).not.toBe(regrantedIdentity);

    activeDefinition = definitionForProbe('/v2/models');
    identityRegistry.providersByContributionKey.set(identityContributionKey, {
      ...identityRegistry.providersByContributionKey.get(identityContributionKey)!,
      definition: activeDefinition,
    });
    settings = buildSettings(40);
    const revisedProbeIdentity = await readIdentity();
    expect(revisedProbeIdentity).not.toBe(endpointIdentity);
    const serializedIdentities = JSON.stringify([
      initialIdentity,
      rotatedSecretIdentity,
      regrantedIdentity,
      endpointIdentity,
      revisedProbeIdentity,
    ]);
    expect(serializedIdentities).not.toContain('secret-one');
    expect(serializedIdentities).not.toContain('secret-two');
    await expect(services.summary({
      ...requestIdentity,
      resolution: initialResolution,
      accountSettings: initialAccountSettings,
      providerSettings: initialProviderSettings,
      savedSecretResources: initialSavedSecretResources,
      registry: initialRegistry,
      dnsEvidence: initialDnsEvidenceByEndpointUrl,
      lifetime: { wallDeadlineAtMs: Date.now() + PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs },
    })).resolves.toMatchObject({
      status: 'success',
      probeObservationIdentity: initialIdentity,
    });
  });

  it('refreshes declared endpoint health on picker demand without replacing fresher catalog or load state', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-health-'));
    temporaryPaths.push(happyHomeDir);
    const localConnectionId = ProviderConnectionIdSchema.parse('pc_lmstudio_health');
    const localContributionKey = 'happier.provider.lmstudio/lmstudio';
    const localDefinition = ProviderContributionV1Schema.parse({
      v: 1,
      id: 'lmstudio',
      name: 'LM Studio',
      kind: 'local',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        localUrlCandidates: ['http://127.0.0.1:1234/v1'],
        capabilities: {
          streaming: 'supported', toolRoundTrips: 'supported',
          statefulResponses: 'supported', reasoningControls: 'supported',
        },
      }],
      catalog: {
        source: 'probe',
        manualModelPolicy: 'allowed',
        probes: [
          { endpointTemplateId: 'responses', path: '/api/v1/models', parser: 'lmstudio-native-models' },
          { endpointTemplateId: 'responses', path: '/v1/models', parser: 'openai-models' },
        ],
      },
      modelLoad: {
        endpointTemplateId: 'responses', path: '/api/v1/models/load', request: 'json-model-id-v1',
        confirmation: 'refresh-catalog-load-state', preflightPolicy: 'advisory',
      },
      discovery: {
        v: 1,
        listener: { executableBasenames: ['llmster'], defaultPorts: [1234] },
        availabilityProbe: {
          endpointTemplateId: 'responses', path: '/api/v1/models', parser: 'lmstudio-native-models',
        },
      },
    });
    const localRegistry = { providersByContributionKey: new Map([[localContributionKey, {
      provenance: 'first_party' as const,
      source: { kind: 'bundled' as const },
      pluginId: 'happier.provider.lmstudio',
      identity: { pluginId: 'happier.provider.lmstudio', localId: 'lmstudio' },
      definition: localDefinition,
    }]]) };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: localConnectionId,
        source: { kind: 'contribution', contributionKey: localContributionKey },
        role: 'default', displayName: 'LM Studio', displayNameMode: 'automatic',
        revision: 0, createdAt: 1, updatedAt: 1,
      }],
    });
    const initial = resolveProviderConnectionForMachine({
      connectionId: localConnectionId,
      machineId: 'machine-a',
      providerSettings: base,
      registry: localRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (initial.status !== 'resolved') throw new Error('Expected LM Studio connection resolution');
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      machineGrants: [{
        v: 1,
        machineId: 'machine-a',
        connectionId: localConnectionId,
        endpointSetFingerprint: initial.record.endpointSetFingerprint,
        connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    let nativeModels: Array<{
      key: string;
      display_name?: string;
      type: string;
      loaded_instances: Array<{ id: string }>;
    }> = [{
      key: 'publisher/model-a', display_name: 'Model A', type: 'llm', loaded_instances: [{ id: 'instance-a' }],
    }];
    const transport = vi.fn(async (_request: ProviderProbeTransportRequest) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ models: nativeModels }), 'utf8'),
    }));
    let observation = 0;
    const accountSnapshot = providerSnapshot(settings);
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      registry: localRegistry,
      featureGate: { isEnabled: () => true },
      resolveAddresses: async () => ['127.0.0.1'],
      getAccountSettingsSnapshot: () => accountSnapshot,
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport,
      }),
      createObservationId: () => `lmstudio-observation-${observation += 1}`,
    });
    const identity = { connectionId: localConnectionId, machineId: 'machine-a' };

    await expect(services.probe(identity)).resolves.toMatchObject({
      status: 'success', models: [{ id: 'publisher/model-a', name: 'Model A' }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const baseline = await services.runtimeStore.read();
    expect(baseline).toMatchObject({
      endpointHealth: [{ state: { status: 'available', observedAt: expect.any(Number) } }],
      catalogs: [{ state: { snapshot: { models: [{ id: 'publisher/model-a' }] } } }],
      modelLoadStates: [{ key: { modelId: 'publisher/model-a' }, loadState: 'loaded' }],
    });

    // Age only the health observation through the real store. Faking the wall
    // clock here compromises the store's owner-lock lease timers and tests the
    // lock implementation instead of picker-demand freshness.
    const staleHealthObservedAt = Date.now() - PROVIDER_HEALTH_REFRESH_TTL_MS - 1;
    await services.runtimeStore.update((state) => ({
      ...state,
      endpointHealth: state.endpointHealth.map((row) => 'observedAt' in row.state
        ? { ...row, state: { ...row.state, observedAt: staleHealthObservedAt } }
        : row),
    }));

    transport.mockClear();
    nativeModels = [{
      key: 'publisher/health-only', type: 'llm', loaded_instances: [],
    }];
    expect(transport).not.toHaveBeenCalled();

    const [modelsResult, summaryResult] = await Promise.all([
      services.models(identity),
      services.summary(identity),
    ]);
    expect(modelsResult).toMatchObject({
      status: 'success',
      models: [expect.objectContaining({ id: 'publisher/model-a', loadState: 'loaded' })],
    });
    expect(summaryResult).toMatchObject({ status: 'success' });
    await vi.waitFor(async () => {
      const state = await services.runtimeStore.read();
      expect(state.endpointHealth).toEqual([
        expect.objectContaining({ state: expect.objectContaining({ status: 'available' }) }),
      ]);
      expect(state.endpointHealth[0]?.state).toMatchObject({ observedAt: expect.any(Number) });
      if (state.endpointHealth[0]?.state.status !== 'available') throw new Error('Expected available endpoint health');
      expect(state.endpointHealth[0].state.observedAt).toBeGreaterThan(staleHealthObservedAt);
      expect(state.endpointHealth[0].state.observedAt).toBeLessThanOrEqual(Date.now());
    }, { timeout: 10_000 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0].url).toBe('http://127.0.0.1:1234/api/v1/models');
    const refreshed = await services.runtimeStore.read();
    expect(refreshed.catalogs).toEqual(baseline.catalogs);
    expect(refreshed.modelLoadStates).toEqual(baseline.modelLoadStates);
  });

  it('threads a trusted local contribution command fallback through the saved authorized probe path', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-runtime-local-fallback-'));
    temporaryPaths.push(happyHomeDir);
    const localConnectionId = ProviderConnectionIdSchema.parse('pc_ollama_fixture');
    const localContributionKey = 'happier.provider.ollama/ollama';
    const localDefinition = ProviderContributionV1Schema.parse({
      v: 1,
      id: 'ollama',
      name: 'Ollama',
      kind: 'local',
      endpointTemplates: [{
        id: 'native', protocol: 'ollama-native', localUrlCandidates: ['http://127.0.0.1:11434'],
        capabilities: {
          streaming: 'supported', toolRoundTrips: 'supported',
          statefulResponses: 'unsupported', reasoningControls: 'supported',
        },
      }],
      catalog: {
        source: 'probe', manualModelPolicy: 'allowed',
        probes: [{ endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' }],
      },
      discovery: {
        v: 1,
        listener: { executableBasenames: ['ollama'], defaultPorts: [11434] },
        availabilityProbe: { endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' },
        catalogFallback: {
          endpointTemplateId: 'native', lookupNames: ['ollama'], fixedArgs: ['list'],
          parser: 'ollama-list-table', endpointEnvName: 'OLLAMA_HOST',
        },
      },
    });
    const localRegistry = {
      providersByContributionKey: new Map([[localContributionKey, {
        provenance: 'first_party' as const,
        source: { kind: 'bundled' as const },
        pluginId: 'happier.provider.ollama',
        identity: { pluginId: 'happier.provider.ollama', localId: 'ollama' },
        definition: localDefinition,
      }]]),
    };
    const base = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: localConnectionId,
        source: { kind: 'contribution', contributionKey: localContributionKey },
        role: 'default', displayName: 'Ollama', displayNameMode: 'automatic',
        revision: 0, createdAt: 1, updatedAt: 1,
      }],
    });
    const initial = resolveProviderConnectionForMachine({
      connectionId: localConnectionId,
      machineId: 'machine-a',
      providerSettings: base,
      registry: localRegistry,
      dnsEvidenceByEndpointUrl: new Map(),
    });
    if (initial.status !== 'resolved') throw new Error('Expected local connection resolution');
    const settings = ProviderSettingsV1Schema.parse({
      ...base,
      machineGrants: [{
        v: 1, machineId: 'machine-a', connectionId: localConnectionId,
        endpointSetFingerprint: initial.record.endpointSetFingerprint,
        connectionSecurityFingerprint: initial.record.connectionSecurityFingerprint,
        confirmedAt: 1,
      }],
    });
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      exitCode: 0,
      stdout: 'NAME ID SIZE MODIFIED\nqwen3:8b model-digest 5GB today\n',
      stderr: '',
    }));
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', happyHomeDir, registry: localRegistry,
      featureGate: { isEnabled: () => true },
      resolveAddresses: async () => ['127.0.0.1'],
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport: async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }),
      }),
      localCatalogFallback: createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool } }),
      createObservationId: () => 'local-command-observation',
    });

    await expect(services.probe({ connectionId: localConnectionId, machineId: 'machine-a' }))
      .resolves.toMatchObject({ status: 'success', models: [{ id: 'qwen3:8b' }] });
    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      lookupNames: ['ollama'],
      args: ['list'],
      env: { OLLAMA_HOST: 'http://127.0.0.1:11434/' },
    }));
    await expect(services.summary({ connectionId: localConnectionId, machineId: 'machine-a' }))
      .resolves.toMatchObject({
        status: 'success',
        summary: { health: 'unreachable', modelCount: 1 },
      });
    // Join the real advisory demand before removing its runtime-store directory.
    await services.scheduleDemandRefresh({ connectionId: localConnectionId, machineId: 'machine-a' }, 'detail_open');
  });
});
