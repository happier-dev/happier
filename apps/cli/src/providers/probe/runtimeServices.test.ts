import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  AccountSettingsSchema,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  createEmptyProviderRuntimeStateFileV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import type { ProviderRuntimeStateStore } from '@/providers/runtimeState';

import { createRuntimeProviderServices } from './runtimeServices';
import {
  createProviderProbeHttpClient,
  type ProviderProbeTransportRequest,
} from './client';

const temporaryPaths: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

function grantedSettings() {
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
    accountSettings: { providerSettingsV1: base },
    registry,
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
      connectionId: localConnectionId, machineId: 'machine-a', accountSettings: { providerSettingsV1: base },
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
      getAccountSettingsSnapshot: () => ({
        source: 'cache', settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
      }),
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

  it('single-flights identical explicit draft probes through the shared scheduler', async () => {
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
      getAccountSettingsSnapshot: () => ({
        source: 'cache', settings: AccountSettingsSchema.parse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
      }),
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

    const first = services.probeDraft(request);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const second = services.probeDraft(request);
    releaseTransport();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'success', models: [{ id: 'draft-model' }] }),
      expect.objectContaining({ status: 'success', models: [{ id: 'draft-model' }] }),
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('single-flights identical post-load catalog refreshes without giving one caller ownership of shared cancellation', async () => {
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
      getAccountSettingsSnapshot: () => ({
        source: 'cache', settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
      }),
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
      expect.objectContaining({ status: 'success' }),
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
    let runtimeState = createEmptyProviderRuntimeStateFileV1('machine-a');
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-model-load-frontier.json',
      read: vi.fn(async () => runtimeState),
      update: vi.fn(async (transform) => {
        runtimeState = await transform(runtimeState);
        return runtimeState;
      }),
      touch: vi.fn(),
      flushTouches: vi.fn(async () => runtimeState),
    };
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
      getAccountSettingsSnapshot: () => ({
        source: 'cache', settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
      }),
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
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account-a',
      }),
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
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account-a',
      }),
    });
    await expect(noAuthUnauthorized.probe(identity)).resolves.toMatchObject({
      status: 'error', error: { code: 'provider_probe_response_invalid' },
    });
  });

  it('projects one opaque probe-observation identity from exact request, authorization, and grant facts', async () => {
    const identityConnectionId = ProviderConnectionIdSchema.parse('pc_observation_identity');
    const identityContributionKey = 'acme.identity/identity';
    const secretKey = new Uint8Array(32).fill(7);
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
    let encryptedValue = encryptSecretStringV1(
      'secret-one',
      secretKey,
      (length) => new Uint8Array(length).fill(3),
    );
    const dnsEvidence = new Map([
      ['https://identity.example/v1', ['1.1.1.1']],
      ['https://identity-override.example/v1', ['1.1.1.2']],
    ]);
    const buildSettings = (confirmedAt: number | null) => {
      const ungranted = ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [connection],
        secretBindingsByConnectionId: {
          [identityConnectionId]: { account: { apiKey: 'secret-identity' } },
        },
      });
      if (confirmedAt === null) return ungranted;
      const resolution = resolveProviderConnectionForMachine({
        connectionId: identityConnectionId,
        machineId: 'machine-a',
        accountSettings: { providerSettingsV1: ungranted },
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
    let runtimeState = createEmptyProviderRuntimeStateFileV1('machine-a');
    // Persistence is the genuine system boundary here; the identity contract
    // exercises the real resolution, authorization, probe, and summary logic.
    const runtimeStore: ProviderRuntimeStateStore = {
      path: '/virtual/provider-runtime-state.json',
      read: async () => runtimeState,
      update: async (transform) => {
        runtimeState = await transform(runtimeState);
        return runtimeState;
      },
      touch: () => undefined,
      flushTouches: async () => runtimeState,
    };
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir: '/virtual/happier-provider-runtime-observation-identity',
      runtimeStore,
      resolveRegistry: async () => identityRegistry,
      resolveAddresses: async (hostname) => hostname === 'identity-override.example' ? ['1.1.1.2'] : ['1.1.1.1'],
      client: createProviderProbeHttpClient({
        resolveAddresses: async (hostname) => hostname === 'identity-override.example' ? ['1.1.1.2'] : ['1.1.1.1'],
        transport,
      }),
      getAccountSettingsSnapshot: () => ({
        source: 'cache',
        settings: AccountSettingsSchema.parse({
          providerSettingsV1: settings,
          secrets: [{
            id: 'secret-identity',
            encryptedValue: { _isSecretValue: true, encryptedValue },
          }],
        }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [secretKey],
        scopeKey: 'account-a',
      }),
      featureGate: { isEnabled: () => true },
    });
    const requestIdentity = { connectionId: identityConnectionId, machineId: 'machine-a' };
    const readIdentity = async (): Promise<string> => {
      const result = await services.summary(requestIdentity);
      expect(result).toMatchObject({
        status: 'success',
        probeObservationIdentity: expect.stringMatching(/^probe-observation:v1:/u),
      });
      if (result.status !== 'success') throw new Error('Expected Provider summary');
      return result.probeObservationIdentity;
    };

    const initialIdentity = await readIdentity();
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

    encryptedValue = encryptSecretStringV1(
      'secret-two',
      secretKey,
      (length) => new Uint8Array(length).fill(4),
    );
    const rotatedSecretIdentity = await readIdentity();
    expect(rotatedSecretIdentity).not.toBe(initialIdentity);

    settings = buildSettings(null);
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
  });

  it('refreshes declared endpoint health on picker demand without replacing fresher catalog or load state', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
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
      accountSettings: { providerSettingsV1: base },
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
    const services = createRuntimeProviderServices({
      machineId: 'machine-a',
      happyHomeDir,
      registry: localRegistry,
      featureGate: { isEnabled: () => true },
      resolveAddresses: async () => ['127.0.0.1'],
      getAccountSettingsSnapshot: () => ({
        source: 'cache', settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
      }),
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
      endpointHealth: [{ state: { status: 'available', observedAt: 1_000 } }],
      catalogs: [{ state: { snapshot: { models: [{ id: 'publisher/model-a' }] } } }],
      modelLoadStates: [{ key: { modelId: 'publisher/model-a' }, loadState: 'loaded' }],
    });

    transport.mockClear();
    nativeModels = [{
      key: 'publisher/health-only', type: 'llm', loaded_instances: [],
    }];
    vi.setSystemTime(32_001);
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
      expect(state.endpointHealth[0].state.observedAt).toBeGreaterThan(31_000);
      expect(state.endpointHealth[0].state.observedAt).toBeLessThan(5 * 60_000);
    });
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
      accountSettings: { providerSettingsV1: base },
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
    const localCatalogFallback = vi.fn(async () => ({
      status: 'success' as const,
      models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }],
    }));
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', happyHomeDir, registry: localRegistry,
      featureGate: { isEnabled: () => true },
      resolveAddresses: async () => ['127.0.0.1'],
      getAccountSettingsSnapshot: () => ({
        source: 'cache', settings: AccountSettingsSchema.parse({ providerSettingsV1: settings }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'account-a',
      }),
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport: async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }),
      }),
      localCatalogFallback: { run: localCatalogFallback },
      createObservationId: () => 'local-command-observation',
    });

    await expect(services.probe({ connectionId: localConnectionId, machineId: 'machine-a' }))
      .resolves.toMatchObject({ status: 'success', models: [{ id: 'qwen3:8b' }] });
    expect(localCatalogFallback).toHaveBeenCalledWith({
      descriptor: localDefinition.discovery?.catalogFallback,
      endpointUrl: 'http://127.0.0.1:11434/',
    });
    await expect(services.summary({ connectionId: localConnectionId, machineId: 'machine-a' }))
      .resolves.toMatchObject({
        status: 'success',
        summary: { health: 'unreachable', modelCount: 1 },
      });
  });
});
