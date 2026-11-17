import axios from 'axios';
import { createServer } from 'node:http';
import { expect, it, onTestFinished, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApiClient } from '@/api/api';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createInstalledProjectAgentLaunchFixture } from '@/daemon/testkit/installedProjectAgentLaunchFixture';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { readNativeExecutionRunOfferedModel } from '@/agent/runtime/bridges/executionRun/structuredOutputAdmission';
import { writeDaemonState } from '@/persistence';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { AccountSettingsSnapshotResolver } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { registerMachineRpcHandlers } from './rpcHandlers';

it('uses admitted Workflow requester credentials and purpose ports for detached native model admission', async () => {
  onTestFinished(() => vi.restoreAllMocks());
  const installed = await createInstalledProjectAgentLaunchFixture({ prepareProject: false });
  const h = installed.f;
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  const pluginId = 'test.detached-native-catalog';
  const agentId = `${pluginId}/agent`;
  const plugin = definePlugin({ id: pluginId, version: '0.0.0', displayName: 'Native catalog fixture',
    entrypoints: { daemon: './daemon.mjs' }, agents: { agent: {
      declaration: { title: 'Native catalog Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        connectedAccounts: [{ purpose: 'primary', service }], capabilities: { sessions: {
          open: ['create'], delivery: ['newTurn'], cancel: false } } },
      factory: () => ({ sessions: { async open() { throw new Error('No native send before admission'); } } }),
      preflightSessionControls: { probeModels: () => [{ id: 'native-model', name: 'Native model', capabilities: { structuredOutput: 'unsupported' } }] },
      sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
    } } });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: h.directory, controller: pluginReloadController,
    plugins: [{ manifest: plugin.manifest, files: {
      'agent.mjs': `export function createRuntime() { return { sessions: { async open() { throw new Error('No native send before admission'); } } }; }`,
      'daemon.mjs': `import { createRuntime } from './agent.mjs'; export function activate(api) {
        api.agents.register('agent', createRuntime, { sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
          preflightSessionControls: { probeModels: () => [{ id: 'native-model', name: 'Native model', capabilities: { structuredOutput: 'unsupported' } }] } }); }`,
    } }] });
  onTestFinished(() => fixture.dispose());
  const purpose = createForegroundPurposeOwnerFixture({ consumer: { pluginId, localId: 'agent' }, service, accountId: 'workflow-account',
    materializeAccount: async () => { throw new Error('This catalog needs no launch material'); } });
  const api = await ApiClient.create(h.bootstrap.credentials);
  const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
    ref: { service, accountId: 'workflow-account' }, authenticationModeId: 'oauth', status: 'connected',
    revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationReady: true, configurationRevision: null, scopes: [],
  }] });
  const homeGet = axios.get;
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    if (new URL(String(url)).pathname === '/v4/connect/qualified/accounts') {
      expect(options?.headers?.Authorization).toBe(`Bearer ${h.bootstrap.credentials.token}`);
      return { status: 200, data: accounts };
    }
    return await homeGet(url, options);
  });
  const readRequesterNativeOfferedModel = async (bootstrap: AdmittedRequesterSessionBootstrap,
    request: Parameters<typeof readNativeExecutionRunOfferedModel>[0], signal?: AbortSignal) =>
    await withAgentPreflightCatalog({ agentId, signal }, catalog => readNativeExecutionRunOfferedModel({ ...request, ...catalog, signal,
      promptCredentials: bootstrap.credentials, accountSettings: bootstrap.savedSecretOperationContext.readSnapshot()?.settings,
      preflightDependencies: { createApiClient: async () => api, activatePurposeBindings: purpose.owner.activatePurposeBindings,
        connectedAccountsOwner: purpose.owner } }));
  const request = { backendTarget: { kind: 'builtInAgent' as const, agentId }, modelId: 'native-model', cwd: h.directory,
    connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
      source: 'connected', selection: 'profile', profileId: 'workflow-account' } } } };
  // Control: the selected Account and native catalog are available.
  await expect(readRequesterNativeOfferedModel(h.bootstrap, request)).resolves.toMatchObject({ id: 'native-model' });
  // Substitute only the loopback daemon's HTTP boundary; keep its admission
  // client and response parser, as in the existing detached Run composition.
  const daemonHttp = createServer((request, response) => {
    if (request.url !== '/execution-run/admission') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ admitted: true }));
  });
  await new Promise<void>(resolve => daemonHttp.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => daemonHttp.close(error => error ? reject(error) : resolve())));
  const daemonAddress = daemonHttp.address();
  if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('Missing fixture daemon endpoint');
  writeDaemonState({ pid: process.pid, httpPort: daemonAddress.port, startedAt: Date.now(),
    startedWithCliVersion: 'fixture', controlToken: 'fixture-control-token' });
  const readSnapshot = () => {
    const snapshot = h.bootstrap.savedSecretOperationContext.readSnapshot();
    if (!snapshot) throw new Error('Requester Account lifetime retired');
    return snapshot;
  };
  const actionsSettingsProvider = createActionSettingsProvider({ getAccountSettings: () => readSnapshot().settings,
    scopeKey: readSnapshot().scopeKey, allowEnvironmentOverride: false });
  // Consume the installed ApiMachine resolver, including its requester role
  // context, rather than supplying only the saved-secret settings projection.
  const readRunSnapshot = Reflect.get(installed.machine, 'executionRunAccountSnapshots') as AccountSettingsSnapshotResolver | undefined;
  if (typeof readRunSnapshot !== 'function') throw new Error('Missing installed Machine Account snapshot owner');
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain' });
  const registration = registerMachineRpcHandlers({ rpcHandlerManager: rpc,
    handlers: { spawnSession: async () => { throw new Error('No Session expected'); }, stopSession: async () => true, requestShutdown() {} },
    deps: { currentMachineId: 'machine', currentServerId: 'session-home', workingDirectory: h.directory,
      executionRunRuntimeAccountId: 'requester', actionsSettingsProvider,
      executionRunAccountSettings: { serverUrl: 'https://session-home.test',
        resolveAccountSettings: () => readSnapshot().settings, resolveAccountSettingsSnapshot: readRunSnapshot,
        actionsSettingsProvider },
      actionOperations: createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester',
        custodyBinding: { serverId: 'session-home', installationId: h.installation.installationId } }),
      createProjectFiniteRuntime: installed.finite,
      readRequesterNativeOfferedModel } });
  onTestFinished(() => registration.dispose());
  const response = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
    ...request, intent: 'review', instructions: 'Review the admitted Project.', permissionMode: 'read_only',
    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
  }, { signal: h.signal, rpcContext: { callerAuthority: 'present_user', requesterSessionBootstrap: h.bootstrap,
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
      installationId: h.installation.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: h.bootstrap.isCurrent } });
  expect(response, JSON.stringify(response)).toMatchObject({ ok: false, errorCode: 'model_structured_output_unsupported',
    details: { executionRunStart: { runCreation: 'noRunCreated' } } });
});
