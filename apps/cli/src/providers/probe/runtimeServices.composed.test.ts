import { definePlugin } from '@happier-dev/plugin-sdk';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
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
import { hydrateSavedSecretCatalog } from "@/settings/secrets/savedSecretCatalogRead";
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createDeferred } from '@/testkit/async/deferred';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';

import { createRuntimeProviderServices } from './runtimeServices';
import {
  createProviderProbeHttpClient,
  type ProviderProbeTransportRequest,
} from './client';
import { PROVIDER_HEALTH_REFRESH_TTL_MS } from './scheduler';
import { createProviderLocalCatalogFallbackRunner } from './localCommand';
import type { ProviderLocalCommandRunner } from './localCommand';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { configuration } from '@/configuration';

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
it.each([false, true])('acquires one vault field for a catalog phase with several authenticated probe requests (detach caller: %s)', async detachCaller => {
  const secretId = formatSharedSavedSecretRefV1('catalog-vault');
  const vaultDefinition = ProviderContributionV1Schema.parse({ ...definition,
    endpointTemplates: [...definition.endpointTemplates, { ...definition.endpointTemplates[0], id: 'responses', protocol: 'openai-responses' }],
    credential: { kind: 'apiKey', required: true, transports: [{ id: 'bearer', protocols: ['openai-chat', 'openai-responses'], uses: ['probe'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
    catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [
      { endpointTemplateId: 'chat', path: '/first', parser: 'openai-models' },
      { endpointTemplateId: 'responses', path: '/second', parser: 'openai-models' },
    ] },
  });
  const vaultRegistry = { providersByContributionKey: new Map([[contributionKey, { ...contribution, definition: vaultDefinition }]]) };
  const settings = ProviderSettingsV1Schema.parse({ ...grantedSettings(vaultRegistry),
    secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: secretId }, byMachineId: {} } },
  });
  const resource = { resourceId: 'catalog-vault', encryptionMode: 'plain' as const, recipientEnvelope: null,
    entry: { ref: secretId, source: 'shared_resource', relationship: 'owner', name: 'Vault', kind: 'apiKey', ownerAccountId: 'owner',
      revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'catalog-vault', mode: 'plain', content: {
      v: 2, name: 'Vault', kind: 'apiKey', source: { kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'main' },
        account: 'account', reference: 'op://vault/item/field' },
    } }),
  };
  const snapshot = providerSnapshot(settings);
  setActiveAccountSettingsSnapshot(snapshot);
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'provider-probe-snapshot-account', encryption: null });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(FeaturesResponseSchema.parse({
    features: { sharing: { enabled: true, savedSecrets: { enabled: true } }, encryption: { plaintextStorage: { enabled: true } } },
  })), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { resources: [resource] } });
  let acquisitions = 0;
  const acquisitionStarted = createDeferred<void>();
  const releaseAcquisition = createDeferred<void>();
  if (!detachCaller) releaseAcquisition.resolve();
  const plugin = definePlugin({ id: 'acme.vault', version: '1.0.0', displayName: 'Vault', entrypoints: { daemon: './daemon.mjs' },
    secretSources: { main: { declaration: { title: 'Vault' }, runtime: {
      async acquire(_input, context) {
        acquisitions += 1;
        acquisitionStarted.resolve();
        await releaseAcquisition.promise;
        context.signal?.throwIfAborted();
        return { ok: true, value: 'vault-key' };
      },
    } } },
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
      instantiateCommittedModule: () => ({ activate: plugin.activate }) }], coldStart: true,
    async resolveContributes(happyHomeDir) {
      return createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
      }));
    },
  });
  const requests: string[] = [];
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-vault-catalog-'));
  temporaryPaths.push(happyHomeDir);
  const services = createRuntimeProviderServices({ machineId: 'machine-a', happyHomeDir, registry: vaultRegistry,
    getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot, featureGate: { isEnabled: () => true },
    resolveAddresses: async () => ['1.1.1.1'],
    secretSources: fixture.registry.secretSources,
    client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport: async request => {
      requests.push(request.headers.authorization ?? '');
      if (new URL(request.url).pathname.endsWith('/first')) return { status: 404, headers: {}, body: Buffer.from('') };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"data":[{"id":"vault-model"}]}') };
    } }),
  });
  try {
    await services.summary({ connectionId, machineId: 'machine-a' });
    expect(acquisitions).toBe(0);
    const identity = { connectionId, machineId: 'machine-a' };
    const scheduled = vi.spyOn(services.probeInfrastructure.scheduler, 'runCatalog');
    const caller = new AbortController();
    const first = services.probe(identity, 'manual_refresh', { signal: caller.signal });
    let result: Awaited<typeof first>;
    if (detachCaller) {
      await acquisitionStarted.promise;
      const second = services.probe(identity);
      await vi.waitFor(() => expect(scheduled).toHaveBeenCalledTimes(2));
      caller.abort();
      releaseAcquisition.resolve();
      await expect(first).resolves.toMatchObject({ status: 'error', error: { code: 'provider_endpoint_unavailable' } });
      result = await second;
    } else result = await first;
    expect(result).toMatchObject({ status: 'success', models: [{ id: 'vault-model' }] });
    expect(requests).toEqual(['Bearer vault-key', 'Bearer vault-key']);
    expect(acquisitions).toBe(1);
  } finally { releaseAcquisition.resolve(); await fixture.dispose(); }
});


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
  it.each(['catalog', 'usage', 'command'] as const)('keeps %s parser retirement at its natural admission boundary', async (kind) => {
    const pluginDefinition = ProviderContributionV1Schema.parse({ ...definition,
      catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'chat', path: '/models', parser: 'credits-v1' }] },
      usageSources: [{ id: 'credits', endpointTemplateId: 'chat', path: '/v1/credits', parser: 'credits-v1' }],
      ...(kind === 'command' ? { discovery: { v: 1,
        listener: { executableBasenames: ['acme'], defaultPorts: [] },
        availabilityProbe: { endpointTemplateId: 'chat', path: '/models', parser: 'credits-v1' },
        catalogFallback: {
        endpointTemplateId: 'chat', lookupNames: ['acme'], fixedArgs: ['models'], parser: 'credits-v1',
      } } } : {}),
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const transport = vi.fn(async (_request: ProviderProbeTransportRequest) => ({ status: kind === 'command' ? 503 : 200,
      headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-parser-dns-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-provider-parser-plugin-'));
    temporaryPaths.push(happyHomeDir, pluginRoot);
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2, id: 'acme.static', version: '1.0.0', displayName: 'Parser admission fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      hostAccess: { required: [], optional: [] }, contributes: { providers: [pluginDefinition] },
    }));
    await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
      api.providers.registerCatalogParser('static', 'credits-v1', () => ({ models: [{ id: 'admitted-generation' }] }));
      api.providers.registerUsageParser('static', 'credits-v1', () => ({ meters: [] }));
    }`);
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId: 'acme.static', manifestVersion: '1.0.0' });
    const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }),
      { isolateInvalidInstalledGenerations: false });
    if (!generationAuthority) throw new Error('Expected committed parser fixture');
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external', existingAgentIds: new Set(),
    }));
    const runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generationAuthority });
    const acquired = await runtime.acquireProviderCatalogParsers?.({ pluginId: 'acme.static', localId: 'static' });
    if (!acquired) throw new Error(JSON.stringify(runtime.pluginDiagnosticsByPluginId));
    const capturedRegistry = { ...runtime.contributes,
      providerActivationOccurrenceIdsByPluginId: new Map([['acme.static', acquired.activationOccurrenceId]]) };
    const snapshot = providerSnapshot(grantedSettings(capturedRegistry));
    const runtimeStore = createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine-a' });
    const services = createRuntimeProviderServices({ machineId: 'machine-a', happyHomeDir, registry: capturedRegistry,
      runtimeStore, getAccountSettingsSnapshot: () => snapshot, featureGate: { isEnabled: () => true },
      resolveAddresses: async () => ['1.1.1.1'], client: createProviderProbeHttpClient({ resolveAddresses: async () => {
        if (kind !== 'command') { entered.resolve(); await release.promise; }
        return ['1.1.1.1'];
      }, transport }),
      localCatalogFallback: createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool: async () => {
        entered.resolve(); await release.promise;
        return { ok: true, exitCode: 0, stdout: 'admitted-output', stderr: '' };
      } } }),
      resolveContributedCatalogParsers: async identity => {
        const acquired = await runtime.acquireProviderCatalogParsers?.(identity);
        return acquired ? { ...acquired, pluginId: identity.pluginId } : null;
      },
      resolveContributedUsageParsers: async identity => await runtime.acquireProviderUsageParsers?.(identity) ?? null,
    });
    try {
      const pending = kind === 'usage' ? services.refreshUsage({ connectionId, machineId: 'machine-a' })
        : services.probe({ connectionId, machineId: 'machine-a' });
      expect(await Promise.race([entered.promise.then(() => 'entered'), pending]),
        'The real admitted request must reach the held DNS boundary').toBe('entered');
      runtime.fencePluginConsumers?.(['acme.static']);
      release.resolve();
      expect(await pending).toMatchObject(kind !== 'usage'
        ? { status: 'success', models: [{ id: 'admitted-generation' }] }
        : { status: 'success', sources: [{ status: 'ok', snapshot: { state: 'loaded_empty' } }] });
      expect(transport).toHaveBeenCalledTimes(1);
      // New acquisition, unlike this admitted finite operation, cannot invoke the retired plugin.
      expect(await runtime.acquireProviderCatalogParsers?.({ pluginId: 'acme.static', localId: 'static' })).toBeNull();
      expect(await runtime.acquireProviderUsageParsers?.({ pluginId: 'acme.static', localId: 'static' })).toBeNull();
    } finally {
      release.resolve();
      await runtime.dispose();
    }
  });
  // The 10-29 natural-boundary ruling admits finite reads once. Revocation
  // affects the next read; a malformed sibling does not erase a valid source.
  it.each(['valid', 'malformed'] as const)('finishes admitted usage after revocation with a %s later source and refuses the next read', async (secondResponse) => {
    const usageDefinition = ProviderContributionV1Schema.parse({ ...definition,
      usageSources: [
        { id: 'first', endpointTemplateId: 'chat', path: '/v1/first', parser: 'credits-v1' },
        { id: 'second', endpointTemplateId: 'chat', path: '/v1/second', parser: 'credits-v1' },
      ],
    });
    const usageRegistry = { providersByContributionKey: new Map([[contributionKey, { ...contribution, definition: usageDefinition }]]),
      providerActivationOccurrenceIdsByPluginId: new Map([['acme.static', 'occurrence-a']]) };
    const settings = grantedSettings(usageRegistry);
    let snapshot = providerSnapshot(settings);
    const secondEntered = createDeferred<void>();
    const release = createDeferred<void>();
    const transport = vi.fn(async (request: ProviderProbeTransportRequest) => {
      if (request.url.endsWith('/second')) { secondEntered.resolve(); await release.promise; }
      return { status: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(request.url.endsWith('/second') && secondResponse === 'malformed' ? '{' : '{"balance":"9.50"}') };
    });
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-usage-currentness-'));
    temporaryPaths.push(happyHomeDir);
    const services = createRuntimeProviderServices({ machineId: 'machine-a', happyHomeDir,
      registry: usageRegistry, getAccountSettingsSnapshot: () => snapshot,
      featureGate: { isEnabled: () => true }, resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      resolveContributedUsageParsers: async () => ({ activationOccurrenceId: 'occurrence-a', isCurrent: () => true, parsersByFormat: {
        'credits-v1': () => ({ meters: [{ meterId: 'credits', label: 'Credits', used: null, limit: null,
          remaining: 9.5, unit: 'usd', utilizationPct: null, resetsAt: null, status: 'ok' }] }),
      } }),
    });
    const pending = services.refreshUsage({ connectionId, machineId: 'machine-a' });
    await secondEntered.promise;
    snapshot = { ...providerSnapshot(ProviderSettingsV1Schema.parse({ ...settings, accountGrants: [] })), settingsVersion: 2 };
    release.resolve();
    const result = await pending;
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Expected settled source outcomes');
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({ sourceId: 'first', status: 'ok', snapshot: { meters: [{ remaining: 9.5 }] } });
    expect(result.sources[1]).toMatchObject(secondResponse === 'valid'
      ? { sourceId: 'second', status: 'ok', snapshot: { meters: [{ remaining: 9.5 }] } }
      : { sourceId: 'second', status: 'error', error: { code: 'provider_probe_response_invalid' } });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await services.refreshUsage({ connectionId, machineId: 'machine-a' })).toMatchObject({
      status: 'error', error: { code: 'provider_connection_disabled' },
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable usage when the admitted runtime omits its optional parser acquirer', async () => {
    const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
    // Partial runtime consumers may omit this public optional capability. Keep
    // the real publication and lease owners beneath that supported boundary.
    const runtimeWithoutUsage = { ...fixture.registry };
    delete runtimeWithoutUsage.acquireProviderUsageParsers;
    await pluginReloadController.adoptPreparedRuntimeRegistry({ registry: runtimeWithoutUsage,
      changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions' });
    try {
      const usageDefinition = ProviderContributionV1Schema.parse({ ...definition,
        usageSources: [{ id: 'credits', endpointTemplateId: 'chat', path: '/credits', parser: 'credits-v1' }],
      });
      const usageRegistry = { providersByContributionKey: new Map([[contributionKey, { ...contribution, definition: usageDefinition }]]) };
      const snapshot = providerSnapshot(grantedSettings(usageRegistry));
      const transport = vi.fn(async (_request: ProviderProbeTransportRequest) => ({
        status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}'),
      }));
      const services = createRuntimeProviderServices({ machineId: 'machine-a', happyHomeDir: configuration.happyHomeDir,
        registry: usageRegistry, getAccountSettingsSnapshot: () => snapshot,
        featureGate: { isEnabled: () => true }, resolveAddresses: async () => ['1.1.1.1'],
        client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      });
      await expect(services.refreshUsage({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject({
        status: 'error', error: { code: 'provider_contribution_unavailable' },
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await retireAdmittedPluginRuntimeRegistry({ controller: pluginReloadController,
        registry: runtimeWithoutUsage, happyHomeDir: fixture.happyHomeDir });
      await fixture.dispose();
    }
  });

  it('refreshes declared usage through Q1 once and omits an unbound optional billing source', async () => {
    const usageDefinition = ProviderContributionV1Schema.parse({ ...definition,
      usageSources: [
        { id: 'credits', endpointTemplateId: 'chat', path: '/v1/credits', parser: 'credits-v1' },
        { id: 'account-credits', endpointTemplateId: 'chat', path: '/v1/account-credits', parser: 'credits-v1',
          billingCredential: { slotId: 'billing', destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } },
      ],
    });
    const usageRegistry = { providersByContributionKey: new Map([[contributionKey, { ...contribution, definition: usageDefinition }]]),
      providerActivationOccurrenceIdsByPluginId: new Map([['acme.static', 'occurrence-a']]) };
    const snapshot = providerSnapshot(grantedSettings(usageRegistry));
    const transport = vi.fn(async (_request: ProviderProbeTransportRequest) => ({
      status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"balance":"9.50"}'),
    }));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-usage-'));
    temporaryPaths.push(happyHomeDir);
    // The external Provider parser is the plugin boundary; all host admission,
    // DNS transport policy and Q1 snapshot normalization below it remain real.
    const services = createRuntimeProviderServices({ machineId: 'machine-a', happyHomeDir,
      registry: usageRegistry, getAccountSettingsSnapshot: () => snapshot,
      featureGate: { isEnabled: () => true }, resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'], transport }),
      resolveContributedUsageParsers: async () => ({ activationOccurrenceId: 'occurrence-a', isCurrent: () => true, parsersByFormat: {
        'credits-v1': (body: unknown) => {
          if (!body || typeof body !== 'object' || !('balance' in body)) throw new Error('Invalid credits');
          return { meters: [{ meterId: 'credits', label: 'Credits', used: null, limit: null,
            remaining: Number(body.balance), unit: 'usd', utilizationPct: null, resetsAt: null, status: 'ok' }] };
        },
      } }),
    });
    expect(transport).not.toHaveBeenCalled();
    const result = await services.refreshUsage({ connectionId, machineId: 'machine-a' });
    expect(result).toMatchObject({ status: 'success', sources: [
      { sourceId: 'credits', status: 'ok', snapshot: { accountSubject: { kind: 'provisionalLocalSubject' },
        meters: [{ remaining: 9.5, unit: 'usd', limit: null, utilizationPct: null }] } },
      { sourceId: 'account-credits', status: 'not_configured' },
    ] });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0].url).toBe('https://models.example/v1/credits');
    await services.refreshUsage({ connectionId, machineId: 'machine-a' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('probes a no-auth Anthropic-compatible connection over HTTP without native login headers', async () => {
    const requests: Array<{ path: string | undefined; headers: IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url, headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'custom-anthropic-model' }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected HTTP test listener');
      const endpointUrl = `http://127.0.0.1:${address.port}/v1`;
      const template = normalizeCustomProviderTemplateV1({ name: 'No-auth Anthropic endpoint',
        protocol: 'anthropic', baseUrl: endpointUrl, catalog: 'probe', modelsPath: '/v1/models' });
      const emptyRegistry = { providersByContributionKey: new Map() };
      const base = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ v: 1, id: 'pc_no_auth', source: { kind: 'custom', template }, role: 'named',
          displayName: template.name, displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 }],
      });
      const resolution = resolveProviderConnectionForMachine({ connectionId: 'pc_no_auth', machineId: 'machine-a',
        providerSettings: base, registry: emptyRegistry,
        dnsEvidenceByEndpointUrl: new Map([[endpointUrl, ['127.0.0.1']]]) });
      if (resolution.status !== 'resolved') throw new Error('Expected no-auth custom connection');
      const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [{ v: 1,
        machineId: 'machine-a', connectionId: 'pc_no_auth', confirmedAt: 1,
        endpointSetFingerprint: resolution.record.endpointSetFingerprint,
        connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
      }] });
      const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-anthropic-no-auth-'));
      temporaryPaths.push(happyHomeDir);
      const snapshot = providerSnapshot(settings);
      const services = createRuntimeProviderServices({ machineId: 'machine-a', happyHomeDir,
        registry: emptyRegistry, getAccountSettingsSnapshot: () => snapshot,
        featureGate: { isEnabled: () => true },
      });
      await expect(services.probe({ connectionId: 'pc_no_auth', machineId: 'machine-a' }))
        .resolves.toMatchObject({ status: 'success', models: [{ id: 'custom-anthropic-model' }] });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.path).toBe('/v1/models');
      expect(requests[0]!.headers.authorization).toBeUndefined();
      expect(requests[0]!.headers['x-api-key']).toBeUndefined();
      expect(requests[0]!.headers.cookie).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['models', 'probe'] as const)('reports transient Account catalog failure before %s without blaming the endpoint', async operation => {
    const credentials = { token: 'provider-catalog-transient', encryption: null };
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    setActiveAccountSettingsSnapshot({ ...providerSnapshot(grantedSettings()),
      scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 503, data: { error: 'server_unavailable' } };
      throw new Error(`Unexpected failed catalog read: ${path}`);
    });
    const services = createRuntimeProviderServices({ machineId: 'machine-a', registry,
      featureGate: { isEnabled: () => true } });
    expect(await services[operation]({ connectionId, machineId: 'machine-a' })).toMatchObject({
      status: 'error', error: { code: 'provider_catalog_unavailable', retryable: true, action: 'retry' },
    });
  });

  it.each(['models', 'probe'] as const)('opens current Account row authority for an explicit ambient %s request before its change hint', async operation => {
    const credentials = { token: 'current-provider-read', encryption: null };
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const settings = grantedSettings();
    const initial = { ...providerSnapshot(settings), source: 'network' as const, rawSettings: {},
      scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) };
    setActiveAccountSettingsSnapshot(initial);
    let catalog = splitProviderSettingsV1(settings).catalog;
    let revision = 1;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: catalog } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      const history = emptyAccountSettingsHistoryCaptureResponse(path);
      if (history) return history;
      throw new Error(`Unexpected explicit Provider read: ${path}`);
    });
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-provider-current-read-'));
    temporaryPaths.push(happyHomeDir);
    const services = createRuntimeProviderServices({ machineId: 'machine-a', registry, happyHomeDir,
      featureGate: { isEnabled: () => true }, resolveAddresses: async () => ['1.1.1.1'],
      client: createProviderProbeHttpClient({ resolveAddresses: async () => ['1.1.1.1'],
        transport: async () => ({ status: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ data: [{ id: 'probe-a' }] })) }) }),
    });
    const identity = { connectionId, machineId: 'machine-a' };
    const initialResult = await services[operation](identity);
    expect(initialResult, JSON.stringify(initialResult)).toMatchObject({ status: 'success' });
    catalog = { ...catalog, manualModelsByConnectionId: { [connectionId]: [{ id: 'manual-current', addedAt: 2 }] } };
    revision += 1;
    const result = await services[operation](identity);
    expect(result).toMatchObject({ status: 'success' });
    expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision,
      catalog: { manualModelsByConnectionId: { [connectionId]: [{ id: 'manual-current' }] } } });
    if (operation === 'models') expect(result).toMatchObject({ models: expect.arrayContaining([
      expect.objectContaining({ id: 'manual-current' }),
    ]) });
  });

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
      expect(observed).toMatchObject({ status: 'error', error: { code: 'provider_catalog_unavailable' } });
    } finally {
      releaseRow.resolve();
      await pending;
    }
  });

  it.each(['probe', 'refreshUsage'] as const)('refuses a newly revoked shared Provider credential on %s without an AccountChange', async operation => {
    const token = 'provider-probe-account';
    const resourceId = 'provider-probe-resource';
    const ref = formatSharedSavedSecretRefV1(resourceId);
    const credentialRegistry = { providersByContributionKey: new Map([[contributionKey, {
      ...contribution,
      definition: ProviderContributionV1Schema.parse({
        ...definition,
        usageSources: [{ id: 'credits', endpointTemplateId: 'chat', path: '/credits', parser: 'credits-v1' }],
        credential: {
          kind: 'apiKey', slotId: 'apiKey', required: true,
          transports: [{ id: 'bearer', protocols: ['openai-chat'], uses: ['probe'], destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' } }],
        },
      }),
    }]]), providerActivationOccurrenceIdsByPluginId: new Map([['acme.static', 'shared-key-usage']]) };
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
    await hydrateSavedSecretCatalog({ token });
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
      resolveContributedUsageParsers: async () => ({ activationOccurrenceId: 'shared-key-usage', isCurrent: () => true,
        parsersByFormat: { 'credits-v1': () => ({ meters: [] }) } }),
    });

    const missing = { status: 'error', error: { code: 'provider_secret_missing' } };
    await expect(services[operation]({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject(operation === 'probe'
      ? missing : { status: 'success', sources: [{ sourceId: 'credits', ...missing }] });
    expect(transport).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.savedSecretResources).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);

    get.mockResolvedValue(materialResponse(2, 'restored-value'));
    await expect(services[operation]({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject(operation === 'probe'
      ? { status: 'success' } : { status: 'success', sources: [{ sourceId: 'credits', status: 'ok' }] });
    expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer restored-value' }),
    }));
    expect(get).toHaveBeenCalledTimes(2);
    get.mockResolvedValue(materialResponse(3, 'rotated-value'));
    await expect(services[operation]({ connectionId, machineId: 'machine-a' })).resolves.toMatchObject(operation === 'probe'
      ? { status: 'success' } : { status: 'success', sources: [{ sourceId: 'credits', status: 'ok' }] });
    expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer rotated-value' }),
    }));
    expect(get).toHaveBeenCalledTimes(3);
    if (operation === 'refreshUsage') {
      const sent = transport.mock.calls.length;
      get.mockResolvedValue({ status: 200, data: { resources: [] } });
      expect(await services.refreshUsage({ connectionId, machineId: 'machine-a' })).toMatchObject({
        status: 'success', sources: [{ sourceId: 'credits', ...missing }],
      });
      expect(transport).toHaveBeenCalledTimes(sent);
      return;
    }
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
    const credentials = { token: 'disabled-ambient-provider', encryption: null };
    setActiveAccountSettingsSnapshot({ ...providerSnapshot(grantedSettings()),
      scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });
    const storedCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const homeHttp = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Disabled Providers cannot read Home catalogs'));

    for (const [featureGate, reader] of [
      [undefined, 'issued'], [{ isEnabled: () => false }, 'issued'],
      [undefined, 'ambient'], [{ isEnabled: () => false }, 'ambient'],
    ] as const) {
      const services = createRuntimeProviderServices({
        machineId: 'machine-a',
        happyHomeDir,
        resolveRegistry,
        ...(reader === 'issued' ? { getAccountSettingsSnapshot } : {}),
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
      })).resolves.toMatchObject({
        status: 'error', error: { code: 'provider_feature_disabled' },
      });
    }

    expect(resolveRegistry).not.toHaveBeenCalled();
    expect(getAccountSettingsSnapshot).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(storedCredentials).not.toHaveBeenCalled();
    expect(homeHttp).not.toHaveBeenCalled();
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
      // Summary starts a real demand refresh. Join it before changing the
      // Account facts it uses or retiring this fixture's Home directory.
      await expect(services.scheduleDemandRefresh(requestIdentity, 'detail_open')).resolves.toBeNull();
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
    await expect(services.scheduleDemandRefresh(requestIdentity, 'detail_open')).resolves.toBeNull();
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

  it.each([false, true])('threads the remaining catalog lifetime through the saved command fallback (expired=%s)', async expired => {
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
    let commandOutcome: 'completed' | 'aborted' | null = null;
    const runSystemTool = vi.fn<ProviderLocalCommandRunner['runSystemTool']>(async request => {
      request.signal?.addEventListener('abort', () => {
        if (commandOutcome === null) commandOutcome = 'aborted';
      }, { once: true });
      await vi.advanceTimersByTimeAsync(expired ? 11_000 : 6_000);
      commandOutcome = request.signal?.aborted ? 'aborted' : 'completed';
      return request.signal?.aborted ? { ok: false, reasonCode: 'aborted' }
        : { ok: true, exitCode: 0,
            stdout: 'NAME ID SIZE MODIFIED\nqwen3:8b model-digest 5GB today\n', stderr: '' };
    });
    let firstProbe = true;
    const services = createRuntimeProviderServices({
      machineId: 'machine-a', happyHomeDir, registry: localRegistry,
      featureGate: { isEnabled: () => true },
      resolveAddresses: async () => ['127.0.0.1'],
      getAccountSettingsSnapshot: (() => { const snapshot = providerSnapshot(settings); return () => snapshot; })(),
      client: createProviderProbeHttpClient({
        resolveAddresses: async () => ['127.0.0.1'],
        transport: async () => {
          if (firstProbe) { firstProbe = false; await vi.advanceTimersByTimeAsync(20_000); }
          return { status: 503, headers: {}, body: Buffer.alloc(0) };
        },
      }),
      localCatalogFallback: createProviderLocalCatalogFallbackRunner({ runner: { runSystemTool } }),
      createObservationId: () => 'local-command-observation',
    });

    vi.useFakeTimers();
    const pending = services.probe({ connectionId: localConnectionId, machineId: 'machine-a' });
    if (expired) {
      await expect(pending).rejects.toMatchObject({ reason: 'deadline' });
      expect(commandOutcome).toBe('aborted');
      return;
    }
    const result = await pending;
    expect(commandOutcome).toBe('completed');
    expect(result).toMatchObject({ status: 'success', models: [{ id: 'qwen3:8b' }] });
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
