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
import { handleActionsCommand } from '@/cli/commands/actions';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from '@/daemon/connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import { registerConnectedAccountAttemptTransactionRoutes } from '../../../../server/sources/app/api/routes/connect/connectedAccountAttemptTransactions/registerConnectedAccountAttemptTransactionRoutes';
import * as sessionSockets from '@/api/session/sockets';
import { USAGE_SOURCE_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/usage/usageSources';

it('delivers public and private authentication completions through CLI, Home and the installed daemon approval executor', async () => {
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  const invocation = new AbortController();
  onTestFinished(async () => { invocation.abort(); for (const close of cleanup.reverse()) await close(); });
  const home = await createDeploymentSocketHome({ encryptionMode: 'e2ee', configureApp: registerConnectedAccountAttemptTransactionRoutes,
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
  const rootActionId = 'usage.sources.root.set';
  const settings = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] },
    [rootActionId]: { approvalRequiredSurfaces: ['cli'] } } });
  const policy = { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: settings }) };
  const content = prepareAccountSettingsV2Content({ credentials, raw: { actionsSettingsV1: settings }, envelopeKind: 'encrypted' });
  await axios.post(`${home.baseUrl}/v2/account/settings`, { expectedVersion: 0, content },
    { headers: { Authorization: `Bearer ${home.token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() } });
  const api = await runWithServerHttpBaseUrl(home.baseUrl, () => ApiClient.create(credentials));
  const registeredMachine = await runWithServerHttpBaseUrl(home.baseUrl, () => api.getMachine(home.machineId));
  if (!registeredMachine) throw new Error('Missing registered fixture Machine');
  const machine = await runWithServerHttpBaseUrl(home.baseUrl, () => api.machineSyncClient(registeredMachine,
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
  let nativeResult = ConnectedAccountAttemptResponseSchema.parse({ status: 'configurationRequired', attemptId: 'connect-attempt',
    target: { kind: 'attempt', attemptId: 'connect-attempt', service, modeId: 'password' }, missingFieldIds: ['mailbox'] });
  let effects = 0;
  let nativeCompletion: Promise<void> | undefined;
  // Replace the native authentication effect only. CLI admission, daemon
  // startup/registration, Home, replay, custody and delivery remain real.
  rpc.registerHandler(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, async () => {
    effects++;
    await nativeCompletion;
    return nativeResult;
  });
  let finishRoot!: () => void;
  const rootCompletion = new Promise<void>(resolve => { finishRoot = resolve; });
  let rootEffects = 0;
  const rootResult = { source: { serverId, machineId: home.machineId, sourceId: 'cli-root-source',
    agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, root: { kind: 'override', path: '/private-usage-root' },
    consent: 'disabled', status: 'found', coverage: 'unknown', pendingCount: 0, asOfMs: null } };
  // The native Machine RPC is the filesystem boundary for this transport test.
  // Like the real handler, serve the admitted caller's routing label.
  rpc.registerHandler(rootActionId, async raw => {
    const input = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[rootActionId].parse(raw);
    rootEffects++;
    await rootCompletion;
    return { source: { ...rootResult.source, serverId: input.serverId } };
  });
  let connectionPhase: string | undefined;
  const unsubscribe = machine.onConnectionStateChange(state => { connectionPhase = state.phase; });
  cleanup.push(unsubscribe);
  machine.connect();
  await expect.poll(() => connectionPhase, { timeout: 10_000 }).toBe('online');
  // This fixture serves finite Actions, without Session-start capabilities.
  // Wait for the actual RPC registrations used by this journey.
  rpc.replayUnacknowledgedHandlerRegistrations();
  expect(await rpc.waitForRegisteredHandlers([CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, rootActionId], { timeoutMs: 10_000 })).toEqual({ status: 'ready' });
  writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test', httpPort: runtime.controlPort,
    controlToken: runtime.controlToken, machineId: home.machineId, accountId: home.accountId });
  let decision: ActionExecuteResult | undefined;
  let approvalId: string | undefined;
  let requestedDecision: 'approve' | 'reject' = 'approve';
  const client = runWithServerHttpBaseUrl(home.baseUrl, () => createConnectedAccountDaemonClient({ credentials, machineId: home.machineId,
    onApprovalRequested: async (artifactId, signal, decide) => {
      approvalId = artifactId;
      const read = await createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId })
        .execute('approval.request.get', { artifactId }, { surface: 'cli', actionCaller: { kind: 'host' }, signal });
      expect(read.ok).toBe(true);
      decision = await decide(requestedDecision); return decision;
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
  // The substituted native producer must publish its real Home address, as
  // beginConnect does, before an operand-free continuation can route to it.
  await runWithServerHttpBaseUrl(home.baseUrl, () => createQualifiedConnectedAccountAttemptTransactionAdapters({
    credentials, getAccountEncryptionMode: async () => 'e2ee', getMachineId: () => home.machineId,
  }).address.acknowledge({ attemptId: 'connect-attempt', kind: 'manual', phase: 'awaitingManual',
    createdAtMs: Date.now(), intent: 'connect', service, modeId: 'password' }));
  // Manual input is retained by its original invocation. Approval can be
  // acknowledged before that invocation finishes its native authentication.
  nativeResult = ConnectedAccountAttemptResponseSchema.parse({ status: 'connected', attemptId: 'connect-attempt',
    account: { service, accountId: 'manual-account' } });
  let finishManual!: () => void;
  nativeCompletion = new Promise<void>(resolve => { finishManual = resolve; });
  decision = undefined;
  const manual = client.authenticate({ operation: 'submitManual', attemptId: 'connect-attempt',
    fields: { token: 'private-manual-client-token' } });
  let manualError: unknown;
  void manual.catch(error => { manualError = error; });
  try {
    await expect.poll(() => effects === 2 || manualError !== undefined, { timeout: 10_000 }).toBe(true);
    if (manualError) throw manualError;
    finishManual();
    await expect(manual).resolves.toEqual(nativeResult);
  } finally { finishManual(); await manual.catch(() => undefined); }
  nativeCompletion = undefined;
  requestedDecision = 'reject';
  await expect(client.authenticate({ operation: 'submitManual', attemptId: 'connect-attempt',
    fields: { token: 'private-rejected-token' } })).rejects.toMatchObject({ code: 'approval_rejected' });
  requestedDecision = 'approve';
  const cancellation = new AbortController();
  const cancelledClient = runWithServerHttpBaseUrl(home.baseUrl, () => createConnectedAccountDaemonClient({ credentials,
    machineId: home.machineId, signal: cancellation.signal,
    onApprovalRequested: () => { cancellation.abort(); },
  }));
  try {
    await expect(cancelledClient.authenticate({ operation: 'submitManual', attemptId: 'connect-attempt',
      // The existing transport contract cannot retract an issued mutation.
      fields: { token: 'private-cancelled-token' } })).rejects.toMatchObject({ code: 'outcome_unknown' });
  } finally { await cancelledClient.dispose(); }
  expect(effects).toBe(2);
  // Generic Actions use the same real CLI -> daemon approval path. Private
  // input and output must settle after --yes without a second client.
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
    output += String(chunk);
    if (typeof encodingOrCallback === 'function') encodingOrCallback();
    else callback?.();
    return true;
  });
  const notices = vi.spyOn(console, 'error').mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  cleanup.push(() => { stdout.mockRestore(); notices.mockRestore(); process.exitCode = previousExitCode; });
  for (const [id, input] of [
    ['connectedServices.authentication.submitManual', { attemptId: 'connect-attempt', fields: { token: 'private-manual-token' } }],
    ['connectedServices.authentication.completeOAuth', { attemptId: 'connect-attempt', completion: {
      code: 'private-oauth-code', callbackUrl: 'https://callback.invalid/', state: 'private-oauth-state' } }],
  ] as const) {
    output = '';
    notices.mockClear();
    const commandLifetime = new AbortController();
    const command = handleActionsCommand(['invoke', id, '--input-json', JSON.stringify(input), '--yes', '--json'], {
      readCredentialsFn: async () => credentials,
    }, AbortSignal.any([invocation.signal, commandLifetime.signal]));
    try { await command; } finally { commandLifetime.abort(); await command; }
    expect(JSON.parse(output)).toMatchObject({ ok: true, kind: 'actions_invoke', data: nativeResult });
    expect(notices.mock.calls.map(([message]) => JSON.parse(String(message))))
      .toContainEqual(expect.objectContaining({ data: { kind: 'approval_request_created',
        artifactId: expect.any(String), actionId: id } }));
    expect(output).not.toContain('private-');
    const notice = notices.mock.calls.map(([message]) => JSON.parse(String(message)))
      .find(message => message.data?.actionId === id);
    const completed = await createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId })
      .execute('approval.request.get', { artifactId: notice.data.artifactId }, { surface: 'cli', actionCaller: { kind: 'host' } });
    if (!completed.ok) throw new Error('Missing generic Action approval receipt');
    const genericReceipt = ApprovalRequestGetResultV1Schema.parse(completed.result).request;
    expect(genericReceipt).toMatchObject({ status: 'executed', actionId: id, execution: { ok: true } });
    expect(JSON.stringify(genericReceipt)).not.toContain('private-');
  }
  expect(effects).toBe(4);
  output = '';
  notices.mockClear();
  const approvalSockets: Array<ReturnType<typeof sessionSockets.createUserScopedSocketConnection>['socket']> = [];
  const createSocket = sessionSockets.createUserScopedSocketConnection;
  const sockets = vi.spyOn(sessionSockets, 'createUserScopedSocketConnection').mockImplementation(options => {
    const connection = createSocket(options);
    approvalSockets.push(connection.socket);
    return connection;
  });
  cleanup.push(() => sockets.mockRestore());
  const rootLifetime = new AbortController();
  let rootSettled = false;
  const rootCommand = handleActionsCommand(['invoke', rootActionId, '--input-json', JSON.stringify({
    serverId, machineId: home.machineId, sourceId: 'cli-root-source', root: '/private-usage-root',
  }), '--yes', '--json'], { readCredentialsFn: async () => credentials },
  AbortSignal.any([invocation.signal, rootLifetime.signal])).finally(() => { rootSettled = true; });
  try {
    // Original-Account Machine Actions retain their private result on Home's
    // original request. --yes must receive Ask before that delivery finishes.
    await expect.poll(() => rootEffects, { timeout: 10_000 }).toBe(1);
    expect(notices.mock.calls.map(([message]) => JSON.parse(String(message))))
      .toContainEqual(expect.objectContaining({ data: { kind: 'approval_request_created',
        artifactId: expect.any(String), actionId: rootActionId } }));
    expect(rootSettled).toBe(false);
    finishRoot();
    await rootCommand;
    expect(JSON.parse(output), output).toMatchObject({ ok: true, kind: 'actions_invoke', data: rootResult });
    expect(approvalSockets.length).toBeGreaterThan(0);
    expect(approvalSockets.every(socket => !socket.active)).toBe(true);
  } finally {
    rootLifetime.abort();
    finishRoot();
    await rootCommand;
  }
  approvalSockets.length = 0;
  const canceledRootLifetime = new AbortController();
  let canceledRootNotified = false;
  const canceledRootExecutor = runWithServerHttpBaseUrl(home.baseUrl, () => createCliActionExecutorFromCredentials({
    credentials, onApprovalRequested: () => { canceledRootNotified = true; canceledRootLifetime.abort(); },
  }));
  try {
    const canceledRoot = await canceledRootExecutor.execute(rootActionId, {
      serverId, machineId: home.machineId, sourceId: 'cli-root-source', root: '/private-canceled-root',
    }, { surface: 'cli', actionCaller: { kind: 'host' }, signal: canceledRootLifetime.signal });
    expect(canceledRootNotified).toBe(true);
    expect(canceledRoot).toMatchObject({ ok: false });
    expect(rootEffects).toBe(1);
    expect(approvalSockets.length).toBeGreaterThan(0);
    // The requester opens its observer before dispatching HTTP. Receiver-side
    // receipt observers retire when that HTTP cancellation reaches Home.
    expect(approvalSockets[0]?.active).toBe(false);
  } finally {
    canceledRootLifetime.abort();
  }
}, 120_000);
