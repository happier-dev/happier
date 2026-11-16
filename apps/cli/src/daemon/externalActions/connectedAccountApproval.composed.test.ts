import { expect, it, onTestFinished, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ConnectedAccountAttemptResponseSchema, CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, normalizeActionsSettingsV1, accountSettingsParse, type ActionExecuteResult } from '@happier-dev/protocol';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
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
import { buildActionExecuteResultFromRecordedApprovalExecution } from '@happier-dev/protocol/actions/actionExecutor';
import { USAGE_SOURCE_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/usage/usageSources';
import type { CliApprovalRequestedHandler } from '@/session/actions/approvals/deferredResult';
import { ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';

it('delivers public and private authentication completions through CLI, Home and the installed daemon approval executor', async () => {
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  const invocation = new AbortController();
  onTestFinished(async () => {
    invocation.abort();
    consentRace?.observerStopped.release(); consentRace?.firstWrite.release();
    consentRace?.allowFirst.release(); consentRace?.firstCommitted.release();
    for (const close of cleanup.reverse()) await close();
  });
  const consentActionId = 'usage.sources.consent.set';
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };
  let consentRace: {
    observerStopped: ReturnType<typeof gate>; firstWrite: ReturnType<typeof gate>;
    allowFirst: ReturnType<typeof gate>; firstCommitted: ReturnType<typeof gate>;
    earlyPrompt: boolean; artifactId?: string; writes: Array<{ writer: string; transition?: string; expectedHeader?: number;
      expectedBody?: number; currentHeader: number; currentBody: number; response?: unknown }>;
  } | undefined;
  const home = await createDeploymentSocketHome({ encryptionMode: 'e2ee', configureApp: async app => {
    await registerConnectedAccountAttemptTransactionRoutes(app);
    app.addHook('preHandler', async request => {
      const race = consentRace;
      if (!race || request.method !== 'POST' || request.url !== `/v1/artifacts/${race.artifactId}`) return;
      const wire = ArtifactJsonUpdateHttpInputV1Schema.parse(request.body);
      if (wire.approvalState !== 'executing') return;
      const ordinal = race.writes.length;
      const current = await db.artifact.findUniqueOrThrow({ where: { id: decodeURIComponent(request.url.split('/')[3]!) } });
      race.writes.push({ writer: ordinal === 0 ? 'replay-claim' : 'deferred-replay-claim',
        transition: wire.approvalState, expectedHeader: wire.expectedHeaderVersion, expectedBody: wire.expectedBodyVersion,
        currentHeader: current.headerVersion, currentBody: current.bodyVersion });
      if (ordinal === 0) {
        race.firstWrite.release();
        await race.observerStopped.promise;
        race.writes[ordinal]!.writer = race.earlyPrompt ? 'early-live-replay-claim' : 'deferred-replay-claim';
        if (race.earlyPrompt) await race.allowFirst.promise;
      } else if (ordinal === 1 && race.earlyPrompt) {
        race.allowFirst.release();
        await race.firstCommitted.promise;
      }
    });
    app.addHook('onSend', async (request, reply, payload) => {
      const race = consentRace;
      if (!race || request.method !== 'POST') return payload;
      if (request.url.endsWith(`/${consentActionId}`)) {
        await race.observerStopped.promise;
        if (race.earlyPrompt) await race.firstWrite.promise;
      } else if (request.url === `/v1/artifacts/${race.artifactId}`) {
        const wire = ArtifactJsonUpdateHttpInputV1Schema.parse(request.body);
        if (wire.approvalState !== 'executing') return payload;
        const write = race.writes.find(item => item.response === undefined && item.expectedHeader === wire.expectedHeaderVersion
          && item.transition === wire.approvalState);
        if (write) {
          const response = typeof payload === 'string' ? JSON.parse(payload) : undefined;
          write.response = response?.success === false ? { success: false, error: response.error,
            headerVersion: response.current?.headerVersion, bodyVersion: response.current?.bodyVersion } : { success: true };
          if (write === race.writes[0]) race.firstCommitted.release();
        }
      }
      return payload;
    });
  },
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
    [rootActionId]: { approvalRequiredSurfaces: ['cli'] }, [consentActionId]: { approvalRequiredSurfaces: ['cli'] } } });
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
    trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
    getApiMachineForSessions: () => machine, spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
    connectedServicesRestartRequestedSessions: new Set(), resolveCurrentMachineExecutionOriginContext:
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
  let nativeResult = ConnectedAccountAttemptResponseSchema.parse({ status: 'awaitingManual', attemptId: 'connect-attempt' });
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
  let consentEffects = 0;
  rpc.registerHandler(consentActionId, async raw => {
    const input = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[consentActionId].parse(raw);
    consentEffects++;
    return { source: { ...rootResult.source, serverId: input.serverId, consent: input.enabled ? 'enabled' : 'disabled' } };
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
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, rootActionId, consentActionId], { timeoutMs: 10_000 })).toEqual({ status: 'ready' });
  writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test', httpPort: runtime.controlPort,
    controlToken: runtime.controlToken, machineId: home.machineId, accountId: home.accountId });
  let decision: ActionExecuteResult | undefined;
  let approvalId: string | undefined;
  let requestedDecision: 'approve' | 'reject' = 'approve';
  const onApprovalRequested: CliApprovalRequestedHandler = async (artifactId, signal) => {
    approvalId = artifactId;
    const read = await createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId })
      .execute('approval.request.get', { artifactId }, { surface: 'cli', actionCaller: { kind: 'host' }, signal });
    expect(read.ok).toBe(true);
    // A separate authenticated app participant decides. The admitted flow
    // determines whether this person or the original caller owns the result.
    decision = await createCliActionExecutorFromCredentials({
      credentials: { ...credentials, token: home.token }, machineId: home.machineId,
    }).execute('approval.request.decide', { artifactId, decision: requestedDecision },
      { surface: 'rpc', authority: 'present_user', actionCaller: { kind: 'host' }, signal });
    return decision;
  };
  const createClient = (callerCredentials: StoredCredentials) => runWithServerHttpBaseUrl(home.baseUrl,
    () => createConnectedAccountDaemonClient({ credentials: callerCredentials, machineId: home.machineId,
      serverId, serverHttpBaseUrl: home.baseUrl, onApprovalRequested }));
  // The fixture's Account token is issued by Home to the present user. Keep
  // that real credential distinct from the automation terminal used below.
  const personClient = createClient({ ...credentials, token: home.token });
  cleanup.push(() => personClient.dispose());
  await expect(personClient.authenticate({ operation: 'beginConnect', service, modeId: 'password' })).resolves.toEqual(nativeResult);
  const client = createClient(credentials);
  cleanup.push(() => client.dispose());
  expect(decision?.ok).toBe(true);
  if (decision?.ok) expect(decision.result).not.toHaveProperty('liveExecution');
  const receipt = await createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId })
    .execute('approval.request.get', { artifactId: approvalId }, { surface: 'cli', actionCaller: { kind: 'host' } });
  if (!receipt.ok) throw new Error('Missing approval receipt');
  const recorded = ApprovalRequestGetResultV1Schema.parse(receipt.result).request;
  expect(recorded).toMatchObject({ status: 'executed', approval: { flow: 'blocking' }, execution: { ok: true },
    executionOriginV1: { authority: 'present_user' } });
  expect(recorded.execution?.result).toEqual({ status: 'awaitingManual', attemptId: 'connect-attempt' });
  expect(buildActionExecuteResultFromRecordedApprovalExecution(recorded))
    .toMatchObject({ ok: false, errorCode: 'approval_result_held' });
  expect(effects).toBe(1);
  const personApprovalId = approvalId;
  // Native automation with durable input defers to the captured Machine. The
  // deciding person receives its fresh live result, never a durable raw copy.
  decision = undefined;
  const nativeService = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
  const nativeBegin = { machineId: home.machineId, service: nativeService, modeId: 'fine-grained-pat' };
  const nativeRequestId = randomUUID();
  const nativeExecutor = createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId, onApprovalRequested });
  const nativeExecution = await nativeExecutor.execute(actionId, nativeBegin, { surface: 'cli', authority: 'account_automation',
    actionCaller: { kind: 'host' }, actionRequestId: nativeRequestId });
  expect(nativeExecution).toMatchObject({ ok: true, result: { status: 'awaitingManual', attemptId: expect.any(String) } });
  if (!nativeExecution.ok) throw new Error('Native begin failed');
  const nativeBeginResult = ConnectedAccountAttemptResponseSchema.parse(nativeExecution.result);
  expect(approvalId).not.toBe(personApprovalId);
  const automatedReceipt = await createCliActionExecutorFromCredentials({ credentials, machineId: home.machineId })
    .execute('approval.request.get', { artifactId: approvalId }, { surface: 'cli', actionCaller: { kind: 'host' } });
  if (!automatedReceipt.ok) throw new Error('Missing automation approval receipt');
  const automatedRequest = ApprovalRequestGetResultV1Schema.parse(automatedReceipt.result).request;
  expect(automatedRequest).toMatchObject({ status: 'executed', approval: { flow: 'deferred' },
    actionArgs: nativeBegin,
    executionOriginV1: { authority: 'account_automation', surface: 'cli', requestId: nativeRequestId } });
  expect(decision).toMatchObject({ ok: true, result: { status: 'executed',
    liveExecution: { ok: true, result: nativeBeginResult } } });
  expect(buildActionExecuteResultFromRecordedApprovalExecution(automatedRequest))
    .toMatchObject({ ok: false, errorCode: 'approval_result_held' });
  // GitHub's portable producer executes its real begin, rather than the
  // substituted legacy Machine authentication RPC used for private operands.
  expect(effects).toBe(1);
  const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
  const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user',
    authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
  const inaccessible = await createCliActionExecutorFromCredentials({
    credentials: { token: outsiderToken, encryption: null, credentialProvenance: 'stored_session' },
  }).execute('approval.request.get', { artifactId: approvalId }, { surface: 'ui', actionCaller: { kind: 'host' } });
  expect(inaccessible).toMatchObject({ ok: false, errorCode: 'approval_not_found' });
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
    serverId, serverHttpBaseUrl: home.baseUrl,
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
  const notices = vi.spyOn(console, 'error').mockImplementation(message => {
    if (!consentRace) return;
    const notice = JSON.parse(String(message));
    if (notice.data?.actionId === consentActionId) consentRace.artifactId = notice.data.artifactId;
  });
  const previousExitCode = process.exitCode;
  cleanup.push(() => { stdout.mockRestore(); notices.mockRestore(); process.exitCode = previousExitCode; });
  const connectedResult = nativeResult;
  for (const [id, input] of [
    ['connectedServices.authentication.beginConnect', nativeBegin],
    ['connectedServices.authentication.submitManual', { attemptId: 'connect-attempt', fields: { token: 'private-manual-token' } }],
    ['connectedServices.authentication.completeOAuth', { attemptId: 'connect-attempt', completion: {
      code: 'private-oauth-code', callbackUrl: 'https://callback.invalid/', state: 'private-oauth-state' } }],
  ] as const) {
    nativeResult = id === actionId
      ? ConnectedAccountAttemptResponseSchema.parse({ status: 'awaitingManual', attemptId: 'connect-attempt' })
      : connectedResult;
    output = '';
    notices.mockClear();
    const commandLifetime = new AbortController();
    const command = handleActionsCommand(['invoke', id, '--input-json', JSON.stringify(input), '--yes', '--json'], {
      readCredentialsFn: async () => credentials,
    }, AbortSignal.any([invocation.signal, commandLifetime.signal]));
    try { await command; } finally { commandLifetime.abort(); await command; }
    expect(JSON.parse(output)).toMatchObject({ ok: true, kind: 'actions_invoke', data: id === actionId
      ? { status: 'awaitingManual', attemptId: expect.any(String) } : nativeResult });
    expect(notices.mock.calls.map(([message]) => JSON.parse(String(message))))
      .toContainEqual(expect.objectContaining({ data: { kind: 'approval_request_created',
        artifactId: expect.any(String), actionId: id } }));
    expect(notices.mock.calls.filter(([message]) => JSON.parse(String(message)).data?.actionId === id)).toHaveLength(1);
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
  }), '--yes', '--json'], { readCredentialsFn: async () => ({ ...credentials, token: home.token }) },
  AbortSignal.any([invocation.signal, rootLifetime.signal])).finally(() => { rootSettled = true; });
  try {
    // The original person retains the private result on Home's original
    // request. An automation token has observation-only result custody.
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
    credentials: { ...credentials, token: home.token },
    onApprovalRequested: () => { canceledRootNotified = true; canceledRootLifetime.abort(); },
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
  // Home may return the deferred proposal after the Account observer has
  // already read it. Keep both real decision writers on the same Artifact CAS
  // basis to expose a duplicate presenter, without replacing internal logic.
  output = '';
  notices.mockClear();
  approvalSockets.length = 0;
  consentRace = { observerStopped: gate(), firstWrite: gate(), allowFirst: gate(), firstCommitted: gate(),
    earlyPrompt: false, writes: [] };
  const race = consentRace;
  const raceSockets = vi.spyOn(sessionSockets, 'createUserScopedSocketConnection').mockImplementation(options => {
    const connection = createSocket(options);
    if (approvalSockets.length === 0) connection.socket.once('disconnect', () => {
      race.earlyPrompt = notices.mock.calls.some(([message]) => JSON.parse(String(message)).data?.actionId === consentActionId);
      race.observerStopped.release();
    });
    approvalSockets.push(connection.socket);
    return connection;
  });
  try {
    await handleActionsCommand(['invoke', consentActionId, '--input-json', JSON.stringify({
      serverId, machineId: home.machineId, sourceId: 'cli-root-source', enabled: false,
    }), '--yes', '--json'], { readCredentialsFn: async () => credentials }, invocation.signal);
    expect(consentEffects, JSON.stringify(race.writes)).toBeLessThanOrEqual(1);
    expect(JSON.parse(output), JSON.stringify(race.writes)).toMatchObject({ ok: true });
    expect(consentEffects, JSON.stringify(race.writes)).toBe(1);
    expect(notices.mock.calls.filter(([message]) => JSON.parse(String(message)).data?.actionId === consentActionId)).toHaveLength(1);
  } finally {
    race.observerStopped.release(); race.firstWrite.release(); race.allowFirst.release(); race.firstCommitted.release();
    consentRace = undefined;
    raceSockets.mockRestore();
  }
}, 120_000);
