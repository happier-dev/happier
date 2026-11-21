import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountCredentialPayloadV1Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { type DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { MachineProviderRpcServices } from '@/api/machine/rpcHandlers.providers';
import { createDaemonControlApp, type startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { createRuntimeProviderModelManagementServices, type RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { resetAgentModelsProbeCacheForTests } from '@/capabilities/probes/agentModelsProbe';
import { updateSettings, writeDaemonState } from '@/persistence';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null,
  support: 'supported' as 'supported' | 'unknown' | 'unsupported', nativeOpens: 0, nativeCatalogReads: 0 }));
// Only the daemon's OS listener and the external native catalog/turn are replaced.
vi.mock('@/daemon/controlServer', async original => ({ ...await original<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input; return { port: 43129, stop: async () => {} };
  } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; boundary.nativeOpens = 0;
  boundary.nativeCatalogReads = 0; resetAgentModelsProbeCacheForTests(); });

it.each(['supported', 'unknown', 'unsupported'] as const)(
  'uses the requester native source through installed SCM, nested Run transport and Account projection (%s)', async support => {
  boundary.support = support;
  const homeId = 'srv_scm_native_catalog';
  const accountId = 'requester';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
  const installedCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const service = { pluginId: 'acme.project-launch', localId: 'accounts' };
  const modelId = 'meta/muse-spark-1.3-contributor';
  const accountSettings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {} } });
  let models: RuntimeProviderModelManagementServices | undefined;
  const projections: DaemonProviderModelProjectionResponseV1[] = [];
  const publicProjections: DaemonProviderModelProjectionResponseV1[] = [];
  const nativeFetch = globalThis.fetch;
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, {
    manifest: createPluginManifestV2Fixture({ id: service.pluginId,
      hostAccess: { required: [{ id: 'native-catalog-environment', capability: 'environment',
        reason: 'Expose the selected fixture Account to its native catalog', scope: { keys: ['SCM_NATIVE_ACCOUNT'] } }], optional: [] },
      contributes: {
      agents: [{ id: 'agent', title: 'Native source fixture', runtime: { kind: 'custom' }, primary: 'sessions',
        connectedAccounts: [{ purpose: 'inference', service: 'accounts', materializationKinds: ['httpHeaders'],
          managedProviderEndpoint: { provider: { pluginId: service.pluginId, localId: 'gateway' }, purpose: 'upstream', modelIdPrefix: 'meta/' } }],
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true, workspaceWrites: 'deny', executionRunContext: { versions: [1] } } },
        providerRequirements: { acceptsProtocols: ['openai-responses'], required: { streaming: true, toolRoundTrips: true },
          credentialSupport: { supportsNoAuth: true, apiKeyTransports: [{ protocol: 'openai-responses',
            destination: { kind: 'httpHeader', names: ['authorization'], formats: ['bearer'] } }] },
          authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
          materialization: 'spawnEnv', applyPolicy: 'restart_session', supportsFreeformModelIds: false } },
        { id: 'source', title: 'Source catalog Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          connectedAccounts: [{ purpose: 'inference', service: 'accounts', materializationKinds: ['environment'], nativeModelIdPrefix: 'meta/' }],
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
      connectedAccountDescriptors: [{ id: 'accounts', title: 'Native source', authentication: { defaultModeId: 'manual',
        modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] } }],
      providers: [{ v: 1, id: 'gateway', name: 'Gateway', kind: 'aggregator',
        endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://source.test/v1',
          capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        managedRuntime: { kind: 'managed', endpointTemplateIds: ['responses'], connectedAccounts: [{ purpose: 'upstream', service: 'accounts',
          materializationKinds: ['httpHeaders'], endpointTemplateIds: ['responses'],
          catalogObservation: { agent: { pluginId: service.pluginId, localId: 'source' }, modelIdPrefix: 'meta/' },
          staticModels: [{ id: 'muse-spark-1.3-contributor', name: 'Muse Contributor' }] }] } }],
    } }),
    files: { 'agent.mjs': 'export function factory() { throw new Error("Configured by native boundary fixture"); }',
      'daemon.mjs': 'export function activate() {}' },
    instantiateCommittedModule: () => ({ activate(api: PluginApi) {
      api.providers.register('gateway', { async start() { throw new Error('Catalog discovery cannot start a Provider'); } });
      api.connectedAccounts.register('accounts', { authentication: { modes: { manual: { kind: 'manual', async complete() {
        return { status: 'connected', accountId: 'selected-source', displayName: 'Native source', scopes: [] };
      } } } }, async refresh() { return { status: 'unavailable' }; }, async revoke() { return { status: 'remoteUnsupported' }; },
        async status() { return { status: 'connected', displayName: 'Native source' }; }, async materialize(request) {
          return request.kind === 'environment' ? { kind: 'environment', env: { SCM_NATIVE_ACCOUNT: 'selected-source' } }
            : { kind: 'httpHeaders', headers: {} };
        } });
      api.agents.register('agent', () => ({ sessions: {
        async open() { throw new Error('No Session creation in catalog admission test'); },
        executionRunContextV1: { async open() { boundary.nativeOpens++; throw new Error('Native admission observed'); } },
      } }), { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 },
        providerBinding: { v: 1, adapterVersion: 1,
          prepare() { return { v: 1, materialization: 'spawnEnv' }; },
          async materialize() { throw new Error('Native catalog admission must not materialize a Provider binding'); } },
        preflightSessionControls: { async probeModels() { return { source: 'dynamic', supportsFreeform: false,
          availableModels: [{ id: 'local-only', name: 'Local model', capabilities: { structuredOutput: 'unknown' } }] }; } } });
      api.agents.register('source', () => ({ sessions: {
        async open() { throw new Error('Source catalog discovery cannot start a Session'); },
      } }), { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 },
        connectedAccountLaunch: { environmentUses: [{ purpose: 'inference', environmentKey: 'SCM_NATIVE_ACCOUNT' }] },
        preflightSessionControls: { async probeModels() { boundary.nativeCatalogReads++; return { source: 'dynamic', supportsFreeform: false,
          availableModels: [{ id: modelId, name: 'Muse Contributor', capabilities: { structuredOutput: boundary.support } }] }; } } });
    } }),
  }, pluginReloadController, { credentials: installedCredentials, accountActionCredentials: installedCredentials, requesterCredentials: installedCredentials,
    serverId: 'scm-native-home', externalActionAccountId: accountId, ordinaryAccountSession: true,
    homeServerIdentityId: homeId, accountSettings, machineAccess: { custodianAccountId: accountId, role: 'manage' },
    machineRpcMethods: [RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE, RPC_METHODS.CAPABILITIES_INVOKE,
      RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, SESSION_RPC_METHODS.EXECUTION_RUN_START],
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    projectProviderModelsForAccount: async (request, context) => {
      if (!models) throw new Error('Missing real Provider composition');
      const projection = await models.projectModelsForAccount(request, context);
      projections.push(projection); return projection;
    },
  });
  await updateSettings(settings => ({ ...settings,
    machineIdByServerId: { ...settings.machineIdByServerId, 'scm-native-home': 'machine' } }));
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === '127.0.0.1' ? nativeFetch(input, init) : homeFetch(input, init);
  }) satisfies typeof fetch);
  if (!boundary.control) throw new Error('Missing installed daemon control owners');
  const controlToken = boundary.control.controlToken;
  const controlApp = createDaemonControlApp(boundary.control);
  await controlApp.listen({ host: '127.0.0.1', port: 0 });
  onTestFinished(() => controlApp.close());
  const address = controlApp.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local control listener');
  writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
    httpPort: address.port, controlToken, machineId: 'machine', accountId });
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  const homePost = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (url, ...args) => {
    const result = String(url).endsWith('/execution-authorization/verify')
      ? { status: 200, data: { ok: true } } : await homePost(url, ...args);
    return result;
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    if (new URL(String(request.url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
      expect(request.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
      return { status: 200, data: { v: 1, rows: [] } };
    }
    if (request.url && request.method?.toUpperCase() === 'GET') return axios.get(request.url, request);
    if (request.url && request.method?.toUpperCase() === 'POST') return axios.post(request.url, request.data, request);
    throw new Error(`Unexpected Home request: ${new URL(String(request.url)).pathname}`);
  });
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v4/connect/qualified/accounts') return { status: 200, data: QualifiedConnectedAccountListResponseV4Schema.parse({ service,
      accounts: [{ ref: { service, accountId: 'selected-source' }, status: 'connected', authenticationModeId: 'manual',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
        configurationRevision: null, scopes: [] }] }) };
    if (path === '/v4/connect/qualified/credential') return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: { service, accountId: 'selected-source' }, authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
      content: { t: 'plain', v: QualifiedConnectedAccountCredentialPayloadV1Schema.parse({ v: 1, values: {} }) }, metadata: { scopes: [] },
    }) };
    return homeRead(url, options);
  });
  const features = { status: 'ready' as const, provenance: 'authenticated' as const,
    features: FeaturesResponseSchema.parse({ features: { execution: { runs: { enabled: true } }, providers: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }) };
  models = createRuntimeProviderModelManagementServices({ machineId: 'machine', happyHomeDir: h.f.directory,
    featureGate: { isEnabled: () => true }, acquireRuntimeLease: async () => {
      const lease = pluginReloadController.tryAcquireRuntimeRegistry();
      if (!lease) throw new Error('Missing installed registry'); return lease;
    }, getAccountSettingsSnapshot: () => { throw new Error('Requester must not read ambient custodian settings'); },
    invokeConnectedAccountNativeModels: async () => { throw new Error('Requester must not borrow custodian native observer'); },
    modelSettingsMutation: async () => { throw new Error('Read-only admission'); } });
  const pickerAccount = h.requester;
  if (!pickerAccount.resolveManagedPurposeBindingIntent || !pickerAccount.invokeConnectedAccountNativeModels)
    throw new Error('Missing installed requester Provider owners');
  const unrelatedProviderOperation = async () => { throw new Error('Unrelated Provider operation reached'); };
  const providerRpcServices: MachineProviderRpcServices = {
    ...models,
    probe: (request, lifetime) => models!.probe(request, 'manual_refresh', lifetime),
    projectModels: async (request, signal) => {
      const projected = await models!.projectModelsForAccount(request, {
        getAccountSettingsSnapshot: pickerAccount.readAccountSettingsSnapshot,
        resolveManagedPurposeBindingIntent: pickerAccount.resolveManagedPurposeBindingIntent!,
        resolveManagedPurposeBindingIntentSelection: pickerAccount.resolveManagedPurposeBindingIntentSelection,
        invokeConnectedAccountNativeModels: pickerAccount.invokeConnectedAccountNativeModels,
        savedSecretOperationContext: pickerAccount.bootstrap.savedSecretOperationContext,
        signal: signal ?? h.signal, isCurrent: () => pickerAccount.isCurrent(),
      });
      publicProjections.push(projected); return projected;
    },
    prepareProfileMigrationSource: unrelatedProviderOperation,
    describeConnections: unrelatedProviderOperation, mutateConnection: unrelatedProviderOperation,
    previewProfileMigration: unrelatedProviderOperation, confirmProfileMigration: unrelatedProviderOperation,
    confirmProfileMigrationConflict: unrelatedProviderOperation,
  };
  h.machine.setRPCHandlers({ spawnSession: h.daemon.spawnSession, stopSession: h.daemon.stopSession, requestShutdown() {} }, {
    externalActionIngressOwner: h.daemon.externalActionIngressOwner,
    getServerFeaturesSnapshot: () => features, resolveServerFeaturesSnapshot: () => features,
    providerRpc: { machineId: 'machine', services: providerRpcServices, featureGate: { isEnabled: () => true } },
  });
  await writeFile(join(h.cwd, 'mise.toml'), '[env]\nFIXTURE = "active"\n');
  runScmExecutable(h.cwd, 'git', ['init']);
  runScmExecutable(h.cwd, 'git', ['add', 'mise.toml']);
  runScmExecutable(h.cwd, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial fixture']);
  await writeFile(join(h.cwd, 'mise.toml'), '[env]\nFIXTURE = "changed"\n');
  const input = { cwd: h.cwd, source: { kind: 'workingTree', area: 'pending' }, outputs: ['walkthrough'],
    modelSelector: { backendTargetKey: `agent:${service.pluginId}/agent`, modelId,
      modelSelection: { source: 'native', agentTargetKey: `agent:${service.pluginId}/agent`, modelId },
      connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/accounts`]: {
        source: 'connected', selection: 'profile', profileId: 'selected-source' } } } }, cachePolicy: { mode: 'bypass' } };
  const target = { kind: 'machine', machineId: 'machine' } as const;
  const prepare = async (actionId: 'scm.diffSummary.generate' | 'agents.models.list', actionInput: unknown, requestId: string) => {
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input: actionInput });
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `admitted-${requestId}`, binding: {
    accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
    serverIdentityId: homeId, machineId: 'machine', installationId: h.f.installation.installationId,
    actionId, requestId: envelope.requestId, target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose: { kind: 'external_action' },
    installationPublicKey: decodeBase64(h.f.installation.publicKey, 'base64url'), credentials: { token: credentials.token },
    randomBytes: length => new Uint8Array(randomBytes(length)) });
  const admitted = await h.daemon.externalActionIngressOwner!.prepareRequesterAccountContext!({ authorization });
  if (!admitted) throw new Error('Missing admitted requester');
  return admitted;
  };
  const admitted = await prepare('scm.diffSummary.generate', input, 'scm-native-source');
  const context = { surface: 'cli' as const, authority: 'present_user' as const,
    serverId: 'scm-native-home', defaultSessionMachineId: 'machine', actionRequestId: 'scm-native-source',
    externalActionExecutionAuthorization: admitted.authorization, externalActionTarget: target };
  try {
    // Admission consumes current observations. A cold catalog never starts a
    // source listing; the public Refresh is the person's recovery boundary.
    const cold = await admitted.executor.execute('scm.diffSummary.generate', input, context);
    expect(cold, JSON.stringify(cold)).toMatchObject({ ok: true, result: { success: false, error: 'model_structured_output_unsupported',
      outputs: { walkthrough: { state: 'failed', reasonCode: 'SUMMARY_FAILED' } } } });
    expect(projections).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'error',
      error: expect.objectContaining({ code: 'provider_catalog_unavailable' }) })]));
    expect(boundary.nativeCatalogReads).toBe(0);
    expect(boundary.nativeOpens).toBe(0);
    projections.length = 0;
    const registryLease = pluginReloadController.tryAcquireRuntimeRegistry();
    if (!registryLease) throw new Error('Missing installed Agent catalog');
    const workerAgentId = readAgentRoutingIdForContributionIdentity(
      indexAgentRoutingIdsByContributionIdentity(registryLease.registry.contributes.agentDefinitionsById.values()),
      { pluginId: service.pluginId, localId: 'agent' });
    registryLease.release();
    if (!workerAgentId) throw new Error('Missing worker Agent routing identity');
    const pickerInput = { machineId: 'machine', agentId: workerAgentId, backendTargetKey: `agent:${service.pluginId}/agent`,
      probe: { cwd: h.cwd, connectedServices: input.modelSelector.connectedServices, bypassCache: true } };
    const picker = await prepare('agents.models.list', pickerInput, 'native-source-picker');
    try {
      const warmed = await picker.executor.execute('agents.models.list', pickerInput, { ...context,
        actionRequestId: 'native-source-picker', externalActionExecutionAuthorization: picker.authorization });
      expect(warmed, JSON.stringify(warmed)).toMatchObject({ ok: true, result: {
        items: expect.arrayContaining([expect.objectContaining({ id: modelId })]) } });
    } finally { await picker.dispose(); }
    expect(publicProjections).toMatchObject([{ status: 'success', groups: [expect.objectContaining({ catalogObserved: true,
      rows: expect.arrayContaining([expect.objectContaining({ compatibility: expect.objectContaining({ confirmed: true }), descriptor: expect.objectContaining({
        capabilities: { structuredOutput: support },
      }) })]),
    })] }]);
    expect(boundary.nativeCatalogReads).toBe(1);
    projections.length = 0;
    const result = await admitted.executor.execute('scm.diffSummary.generate', input, context);
    expect(projections, JSON.stringify(result)).toMatchObject([{ status: 'success', groups: [expect.objectContaining({
      catalogObserved: true, rows: expect.arrayContaining([expect.objectContaining({ ref: expect.objectContaining({ modelId }),
        descriptor: expect.objectContaining({ capabilities: { structuredOutput: support } }) })]),
    })] }]);
    expect(boundary.nativeCatalogReads).toBe(1);
    // The admitted Run reaches the unavailable external gateway. Catalog
    // admission itself must never require a model turn in this regression.
    expect(boundary.nativeOpens, JSON.stringify(result)).toBe(0);
    if (support === 'supported') expect(result).toMatchObject({ ok: true, result: { success: true, runId: expect.any(String) } });
    else expect(result).toMatchObject({ ok: true, result: { success: false, error: 'model_structured_output_unsupported',
      outputs: { walkthrough: { state: 'failed', reasonCode: 'SUMMARY_FAILED' } } } });
  } finally { await admitted.dispose(); }
});
