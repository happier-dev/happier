import { expect, it, onTestFinished, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { ConnectedAccountAttemptResponseSchema, CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, normalizeActionsSettingsV1, accountSettingsParse, type ActionExecuteResult } from '@happier-dev/protocol';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { auth } from '../../../../server/sources/app/auth/auth';
import { ApiClient } from '@/api/api';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createConnectedAccountDaemonClient } from '@/cli/commands/connect/connectedAccountDaemonClient';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { publishServerHttpRuntimeOrigin, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, writeStoredCredentialsForServerId, writeDaemonState, type StoredCredentials } from '@/persistence';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/rpc/methods';

it('delivers fresh beginConnect configuration through CLI, Home and the installed daemon approval executor', async () => {
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  onTestFinished(async () => { for (const close of cleanup.reverse()) await close(); });
  const home = await createDeploymentSocketHome({ encryptionMode: 'e2ee',
    prepareMachineContent: (key, metadata) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key,
      encryptionVariant: 'dataKey' }).encodeStored(metadata) });
  cleanup.push(() => home.close());
  if (!home.encryption || !home.machineEncryptionKey) throw new Error('Missing encrypted fixture material');
  vi.stubEnv('HAPPIER_SERVER_URL', home.baseUrl);
  vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'connect-custody');
  reloadConfiguration();
  cleanup.push(() => { vi.unstubAllEnvs(); reloadConfiguration(); });
  const token = await auth.createToken(home.accountId, undefined, { kind: 'terminal', authority: 'account_automation',
    authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
  const credentials: StoredCredentials = { token, encryption: home.encryption, credentialProvenance: 'stored_session' };
  const unpublish = publishServerHttpRuntimeOrigin(home.baseUrl, 'https');
  cleanup.push(() => unpublish());
  const serverId = configuration.activeServerId;
  await updateSettings(settings => ({ ...settings, machineId: home.machineId, servers: { ...settings.servers, [serverId]: {
    id: serverId, name: 'Connect custody', serverUrl: home.baseUrl, webappUrl: home.baseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
    homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: home.serverId,
      canonicalServerUrl: home.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
  } } }));
  await writeStoredCredentialsForServerId(serverId, credentials);
  // Publish the fixture installation at the real isolated filesystem boundary,
  // so synchronous Machine reads and asynchronous daemon startup share it.
  await mkdir(dirname(configuration.installationIdentityFile), { recursive: true });
  await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1,
    installationId: home.installationId, createdAt: 1,
    publicKey: Buffer.from(home.keys.publicKey).toString('base64url'), privateKey: Buffer.from(home.keys.secretKey).toString('base64url') }), { mode: 0o600 });
  const actionId = 'connectedServices.authentication.beginConnect';
  const settings = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } });
  const policy = { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: settings }) };
  const content = prepareAccountSettingsV2Content({ credentials, raw: { actionsSettingsV1: settings }, envelopeKind: 'encrypted' });
  await axios.post(`${home.baseUrl}/v2/account/settings`, { expectedVersion: 0, content },
    { headers: { Authorization: `Bearer ${home.token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() } });
  const api = await runWithServerHttpBaseUrl(home.baseUrl, () => ApiClient.create(credentials));
  const registeredMachine = await runWithServerHttpBaseUrl(home.baseUrl, () => api.getMachine(home.machineId));
  if (!registeredMachine) throw new Error('Missing registered fixture Machine');
  const machine = runWithServerHttpBaseUrl(home.baseUrl, () => api.machineSyncClient(registeredMachine,
    undefined, { resolveCurrentServerIdentityId: () => home.serverId }));
  const runtime = await startDaemonSessionControlRuntime({ machineId: home.machineId, credentials,
    serverId, serverBaseUrl: home.baseUrl, externalActionAccountId: home.accountId,
    api, connectedServicesMaterializationBaseDir: join(home.baseDir, 'connected-services'),
    daemonSessionMutationCustody: { stageTranscriptEvent: async () => { throw new Error('Unexpected Session event'); },
      stageTranscriptMessage: async () => { throw new Error('Unexpected Session message'); } },
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
    getApiMachineForSessions: () => machine, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    connectedServicesRestartRequestedPids: new Set(), resolveCurrentMachineExecutionOriginContext:
      createCurrentMachineExecutionOriginContextResolver({ serverUrl: home.baseUrl, resolveCurrentMachineId: () => home.machineId,
        resolveCurrentServerIdentityId: () => home.serverId }),
    beforeShutdown: async () => {}, onHappySessionWebhook: async () => { throw new Error('Unexpected Session start'); },
    requestShutdown() {}, processEnv: {},
  });
  cleanup.push(async () => { await machine.shutdown(); await runtime.stopControlServer(); });
  const ingress = runtime.externalActionIngressOwner;
  if (!ingress) throw new Error('Missing installed external Action owner');
  machine.setRPCHandlers({ spawnSession: async () => { throw new Error('Unexpected Session spawn'); },
    stopSession: async () => true, requestShutdown() {} }, { actionsSettingsProvider: policy, externalActionIngressOwner: ingress });
  const rpc: unknown = Reflect.get(machine, 'rpcHandlerManager');
  if (!(rpc instanceof RpcHandlerManager)) throw new Error('Missing installed RPC manager');
  const service = { pluginId: 'happier.channel.email', localId: 'email-imap-smtp' };
  const nativeResult = ConnectedAccountAttemptResponseSchema.parse({ status: 'configurationRequired', attemptId: 'connect-attempt',
    target: { kind: 'attempt', attemptId: 'connect-attempt', service, modeId: 'password' }, missingFieldIds: ['mailbox'] });
  let effects = 0;
  // Replace the native authentication effect only. CLI admission, daemon
  // startup/registration, Home, replay, custody and delivery remain real.
  rpc.registerHandler(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, async () => { effects++; return nativeResult; });
  let connectionPhase: string | undefined;
  const unsubscribe = machine.onConnectionStateChange(state => { connectionPhase = state.phase; });
  cleanup.push(unsubscribe);
  machine.connect();
  await expect.poll(() => connectionPhase, { timeout: 10_000 }).toBe('online');
  // This fixture serves finite Actions, without Session-start capabilities.
  // Wait for the actual RPC registrations used by this journey.
  rpc.replayUnacknowledgedHandlerRegistrations();
  expect(await rpc.waitForRegisteredHandlers([CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1], { timeoutMs: 10_000 })).toEqual({ status: 'ready' });
  writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test', httpPort: runtime.controlPort,
    controlToken: runtime.controlToken, machineId: home.machineId, accountId: home.accountId });
  let decision: ActionExecuteResult | undefined;
  let approvalId: string | undefined;
  const client = runWithServerHttpBaseUrl(home.baseUrl, () => createConnectedAccountDaemonClient({ credentials, machineId: home.machineId,
    onApprovalRequested: async (artifactId, signal, decide) => {
      approvalId = artifactId;
      const read = await createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId })
        .execute('approval.request.get', { artifactId }, { surface: 'cli', actionCaller: { kind: 'host' }, signal });
      expect(read.ok).toBe(true);
      decision = await decide('approve'); return decision;
    },
  }));
  cleanup.push(() => client.dispose());
  await expect(client.authenticate({ operation: 'beginConnect', service, modeId: 'password' })).resolves.toEqual(nativeResult);
  expect(decision).toMatchObject({ ok: true, result: { status: 'executed', liveExecution: { ok: true, result: nativeResult } } });
  const receipt = await createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId })
    .execute('approval.request.get', { artifactId: approvalId }, { surface: 'cli', actionCaller: { kind: 'host' } });
  if (!receipt.ok) throw new Error('Missing approval receipt');
  const recorded = ApprovalRequestGetResultV1Schema.parse(receipt.result).request;
  expect(recorded).toMatchObject({ status: 'executed', execution: { ok: true } });
  expect(recorded.execution?.result).toEqual({ redacted: true });
  expect(effects).toBe(1);
}, 120_000);
