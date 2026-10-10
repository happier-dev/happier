import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController, type PluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSharedGatewayRegistryTestkit } from '@/plugins/runtime/sharedGatewayRegistry.testkit';

/** Real committed plugin/Agent/Provider source. Only endpoint transport is
 * supplied by each test; no authorization, registry or materializer is mocked. */
export async function createManagedRunLaunchFixture(input: Readonly<{ directory?: string; controller?: PluginReloadController; remote?: boolean; probeCatalog?: boolean; physicalGateway?: boolean; materializationUrl?: string }> = {}) {
  const directory = input.directory ?? await mkdtemp(join(tmpdir(), 'happier-managed-run-'));
  const pluginId = 'acme.managed-run';
  const agentId = `${pluginId}/agent`;
  const agentTargetKey = `agent:${agentId}`;
  const gateway = input.physicalGateway ? createSharedGatewayRegistryTestkit({ directory,
    ...(input.controller ? { controller: input.controller } : {}),
    ...(input.probeCatalog ? { catalog: { source: 'static+probe' as const, manualModelPolicy: 'catalog-only' as const,
      staticModels: [{ id: 'example', name: 'Example' }], sourceRegistryVersion: 'fixture-registry:v1',
      probes: [{ endpointTemplateId: 'api', path: '/models', parser: 'openai-models' as const }] } } : {}),
    credential: { kind: 'apiKey', required: false, slotId: 'apiKey', transports: [{ id: 'bearer',
      protocols: ['openai-responses'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
    compatibilityOverrides: [{ agentTargetKey, protocol: 'openai-responses', status: 'verified', reason: 'Fixture endpoint contract',
      evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-09' } }],
    resolveAccountTarget: async (target, signal) => {
      signal.throwIfAborted();
      if (target.kind !== 'account') throw new Error('Expected exact Account target');
      return { account: target.account, displayName: 'Fixture account' };
    },
  }) : null;
  const happyHomeDir = gateway?.happyHomeDir ?? directory;
  const machineId = gateway ? 'machine' : 'worker';
  const pluginRoot = join(directory, 'fixture-source');
  if (gateway) await gateway.install(gateway.pluginId, '1.0.0', true);
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Managed Run fixture',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
    contributes: {
      agents: [{ id: 'agent', title: 'Run Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true,
          executionRunContext: { versions: [1] } } },
        providerRequirements: { acceptsProtocols: ['openai-responses'], required: { streaming: true },
          credentialSupport: { supportsNoAuth: true, apiKeyTransports: [{ protocol: 'openai-responses',
            destination: { kind: 'httpHeader', names: 'anyValidated', formats: ['bearer'] } }] },
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['RUN_PROVIDER_TOKEN'] },
          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: false } }],
      ...(gateway ? {} : { providers: [{ v: 1, id: 'gateway', name: 'Gateway', kind: 'aggregator',
        credential: { kind: 'apiKey', required: false, slotId: 'apiKey', transports: [{ id: 'bearer',
          protocols: ['openai-responses'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
        endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
          capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } }],
        catalog: input.probeCatalog
          ? { source: 'probe', sourceRegistryVersion: 'fixture-registry:v1', manualModelPolicy: 'catalog-only',
              probes: [{ endpointTemplateId: 'responses', path: '/models', parser: 'openai-models' }] }
          : { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'model-a', name: 'Model A' }] },
        managedRuntime: { kind: 'managed', sharing: 'connectionMachine', endpointTemplateIds: ['responses'] },
        compatibilityOverrides: [{ agentTargetKey, protocol: 'openai-responses', status: 'verified',
          reason: 'Fixture endpoint contract', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-09' } }],
      }] }),
    },
  }), 'utf8');
  await writeFile(join(pluginRoot, 'agentRuntime.mjs'), `import { createFiniteExecutionRunHostRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
  async function requestEndpoint(request, input, signal) {
    const endpoint = request.providerBinding?.upstream.normalizedUrl;
    if (!endpoint) return;
    const response = await fetch((endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint) + '/responses', { method: 'POST',
      headers: { Authorization: 'Bearer ' + request.launchEnvironment.values.RUN_PROVIDER_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.providerBinding.model.id, input: input.text }), signal });
    if (!response.ok) throw new Error('Managed Run endpoint refused: ' + response.status);
    await response.text();
  }
  export function fixtureAgentRuntimeFactory() { return { sessions: { executionRunContextV1: { async open(request, context) {
    if (request.kind !== 'create') throw new Error('Fixture supports create only');
    return createFiniteExecutionRunHostRuntime({ request, signal: context.signal,
      async execute({ signal, emit }) { await requestEndpoint(request, request.input, signal);
        emit({ kind: 'output-delta', channel: 'assistant', text: 'Managed Run completed' });
        return { status: 'complete' }; },
      mapFailure() { return { code: 'fixture_endpoint_failed', message: 'Fixture endpoint refused' }; },
      unsupportedSendDiagnostic: { code: 'fixture_finite_run', message: 'Fixture Run is finite' }
    });
  } }, async open(request, context) {
    const listeners = new Set();
    let sequence = 0;
    const emit = event => { const value = { ...event, sequence: ++sequence, sessionId: request.sessionId, emittedAtMs: Date.now() };
      for (const listener of listeners) listener(value); };
    return {
      async send(input, options) {
        const turnId = input.delivery.turnId;
        emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
        emit({ kind: 'turn-start', turnId, startedBy: 'host' });
        await requestEndpoint(request, input.input, options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal);
        emit({ kind: 'message-delta', turnId, channel: 'assistant', text: 'Managed Run completed' });
        emit({ kind: 'turn-complete', turnId });
        return { status: 'admitted' };
      },
      async cancel(input) { emit({ kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason });
        return { status: 'requested', turnId: input.turnId }; },
      watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
      async dispose() { listeners.clear(); }
    };
  } } }; }
  `, 'utf8');
  await writeFile(join(pluginRoot, 'daemon.mjs'), `import { fixtureAgentRuntimeFactory } from './agentRuntime.mjs';
  export function activate(api) {
    ${gateway ? '' : "api.providers.register('gateway', { async start() { throw new Error('Worker must not start a managed Provider'); } });"}
    api.agents.register('agent', fixtureAgentRuntimeFactory, {
      sessionRunnerFactory: { module: './agentRuntime.mjs', export: 'fixtureAgentRuntimeFactory', runtimeApiVersion: 1 },
      providerBinding: { v: 1, adapterVersion: 1,
      prepare() { return { v: 1, materialization: 'spawnEnv' }; },
      async materialize(input) { if (input.credential.kind !== 'apiKey') throw new Error('Expected consumer bearer');
        ${input.materializationUrl ? `await fetch(${JSON.stringify(input.materializationUrl)});` : ''}
        return { v: 1, kind: 'spawnEnv', env: [{ name: 'RUN_PROVIDER_TOKEN', value: input.credential.value, source: 'provider' }] }; }
    } });
  }`, 'utf8');
  const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
  await writeCommittedLocalPathPluginFixture({ happyHomeDir, pluginId, sourceRootPath: pluginRoot, preserveExistingPlugins: true, plugin: {
    source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot,
      manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json') },
    compatibility: { status: 'unknown', diagnostics: [] },
    install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null, trust: createPluginTrustRecord({ pluginId, distribution, approvedAtMs: 1 }) },
    state: { enabled: true },
  } });
  const mergedContributes = createMergedContributionRegistry(projectLoadedPluginContributes({
    loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external', existingAgentIds: new Set(),
  }), {});
  if (!mergedContributes.providersByContributionKey) throw new Error('Missing committed Provider projection');
  const contributes = { ...mergedContributes, providersByContributionKey: mergedContributes.providersByContributionKey };
  const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {});
  if (!generationAuthority) throw new Error('Missing committed plugin generation');
  const controller = gateway?.controller ?? input.controller ?? createPluginReloadController();
  const lease = await controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () =>
    gateway ? await gateway.createRegistry(new Set()) : await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generationAuthority }) });
  const registry = lease.registry;
  const activated = await registry.activateContributionsOnDemand([{ pluginId, family: 'agents', localId: 'agent' }]);
  if (!registry.activatedPluginIds.has(pluginId)) throw new Error(`Managed Run fixture activation refused: ${JSON.stringify(activated)}`);
  if (!registry.agentRuntimesByAgentId.has(agentId)) throw new Error(`Managed Run Agent registration refused: ${JSON.stringify(activated)}`);
  const base = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
    v: 1, id: 'run-gateway', source: { kind: 'contribution', contributionKey: `${gateway?.pluginId ?? pluginId}/gateway` }, deployment: { kind: 'managedLocal' },
    ...(gateway ? { purposeBindingDefaults: { upstream: gateway.purposeBindings.bindings[0]!.target } } : {}),
    ...(input.remote ? { gatewayPlacement: { kind: 'machine', machineId: 'hub' } } : {}),
    role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1,
  }] });
  const resolution = resolveProviderConnectionForMachine({ connectionId: 'run-gateway', machineId,
    providerSettings: base, registry: contributes, dnsEvidenceByEndpointUrl: new Map() });
  if (resolution.status !== 'resolved') throw new Error('Expected managed connection');
  const settings = ProviderSettingsV1Schema.parse({ ...base, machineGrants: [{ v: 1, connectionId: 'run-gateway', machineId,
    connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
    endpointSetFingerprint: resolution.record.endpointSetFingerprint, confirmedAt: 1 }] });
  const { catalog, defaults } = splitProviderSettingsV1(settings);
  const snapshot: ActiveAccountSettingsSnapshot = { source: 'cache', scopeKey: resolveAccountSettingsScopeKeyForToken('run-account'),
    settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }), settingsVersion: 1,
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog }, loadedAtMs: 1, settingsSecretsReadKeys: [] };
  return { happyHomeDir, agentId, agentTargetKey, machineId, gateway, lease, snapshot, contributes, providerSettings: settings, record: resolution.record,
    connectionSecurityFingerprint: resolution.record.connectionSecurityFingerprint,
    async cleanup() { await lease.release(); await controller.shutdown(); gateway?.disposeCredentialBoundary();
      await rm(directory, { recursive: true, force: true }); } };
}
