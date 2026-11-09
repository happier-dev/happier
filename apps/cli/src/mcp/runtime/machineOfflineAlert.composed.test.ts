import axios from 'axios';
import nacl from 'tweetnacl';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ActionsSettingsV1Schema, AccountSettingsV2UpdateRequestSchema, accountSettingsParse,
  deriveAccountRemoteAlertPolicyV1, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import type { AccountSettingsStoredContentEnvelope, SessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { ActionExecuteFailureSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { handleActionsCommand } from '@/cli/commands/actions';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createDaemonControlApp } from '@/daemon/controlServer';
import type { TrackedSession } from '@/daemon/types';
import { clearTrackedRunnerAgentDaemonServiceAdmission } from '@/daemon/agentRuntime/clearTrackedRunnerAgentDaemonServiceAdmission';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { prepareExternalActionRequesterAccountAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionRequestEnvelopeV1Schema, externalActionExecutionAuthorizationRequestSchemaForActionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import * as installationStore from '@/daemon/identity/store';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

const processIdentity = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn<(event: string, args: unknown[]) => unknown>());
// OS process identity is the only substituted authority boundary.
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));
// Socket.IO is the Account change-notification transport, not approval logic.
vi.mock('socket.io-client', async () => {
  const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
  return { io: () => createApiSessionSocketStub({ emit: (event, args) => machineRpc(event, args),
    emitWithAck: (event, payload) => new Promise(resolve => { machineRpc(event, [payload, resolve]); }) }) };
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  resetInMemoryAccountSettingsContextForTests(); resetActiveAccountSettingsSnapshotForTests();
});

it.each([false, true])('routes delayed Agent approval through its Account owner; only replaced installation is stale (changed=%s)', async (installationChanged) => {
  const sessionId = `c${'a'.repeat(24)}`;
  const machineId = 'alert-machine';
  const serverId = 'alert-home';
  const serverUrl = 'https://alert-home.test';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alert-account', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
    credentialProvenance: 'stored_session' as const, encryption: null };
  const decidingCredentials = { ...credentials, token: `e30.${Buffer.from(JSON.stringify({ sub: 'alert-account', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.different-signature` };
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
  // Installation-file custody is an OS boundary; signing and verification stay real.
  vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
    installationId: 'alert-installation', publicKey: Buffer.from(keys.publicKey).toString('base64url'),
    privateKey: Buffer.from(keys.secretKey).toString('base64url') });
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_alert' } } });
  const nativeFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => String(url).startsWith(`${serverUrl}/v1/features`)
    || String(url).startsWith(`${serverUrl}/features`) ? Response.json(features) : nativeFetch(url, init));
  const policy = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'settings.set': ['agent', 'mcp'] } });
  let content: AccountSettingsStoredContentEnvelope = { t: 'plain', v: { actionsSettingsV1: policy,
    favoriteMachines: ['neighbor'], machineOfflineAlertsV1: { machineIds: ['peer'] } } };
  let version = 1;
  let conflict = true;
  let accountMode: 'plain' | 'e2ee' = 'plain';
  let currentnessAvailable = true;
  let metadataPrivacyRefused = false;
  let currentInstallationId = 'alert-installation';
  let sessionCallerCurrent = true;
  let retiredApprovalRequestId: string | undefined;
  let metadata = JSON.stringify(createTestMetadata({ machineId, permissionMode: 'default' }));
  let metadataVersion = 1;
  let metadataLayoutVersion: 0 | 1 = 0;
  let ownerMetadata: SessionOwnerMetadataEnvelopeV1 | null = null;
  let agentState: string | null = null;
  let agentStateVersion = 0;
  const rootRequestIds = new Map<string, string>();
  const artifacts = new Map<string, Record<string, unknown>>();
  let notifyApprovalCreated!: (artifactId: string) => void;
  const approvalCreated = new Promise<string>(resolve => { notifyApprovalCreated = resolve; });
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    if (config?.headers?.Authorization === undefined) {
      const actionId = String(config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'alert-home-proof', effectActionId: actionId,
        target: actionId === 'session.title.set' ? { kind: 'session', sessionId } : { kind: 'machine', machineId },
        installationId: 'alert-installation', requestId: rootRequestIds.get(actionId)!,
        method: 'GET', path: new URL(url).pathname, publicKey: keys.publicKey,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    } else expect([`Bearer ${credentials.token}`, `Bearer ${decidingCredentials.token}`]).toContain(config.headers.Authorization);
    if (url === `${serverUrl}/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', metadata, metadataVersion, agentState, agentStateVersion, share: null,
      ...(metadataLayoutVersion === 1 ? { metadataLayoutVersion, ownerMetadata } : {}),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    }) } };
    if (url.endsWith('/v1/account/encryption/currentness')) return currentnessAvailable
      ? { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) }
      : { status: 503, data: { error: 'unavailable' } };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: accountMode, updatedAt: 1 } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
    if (url === `${serverUrl}/v1/machines/${machineId}`) return { status: 200, data: { machine: {
      id: machineId, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      kind: 'persistent', active: false, installationId: currentInstallationId,
      installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
    } } };
    const artifact = artifacts.get(url.split('/').at(-1)!);
    if (artifact) return { status: 200, data: artifact };
    throw new Error(`Unexpected Home read: ${url}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    expect(new URL(String(request.url)).pathname).toBe(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1);
    return { status: 200, data: { tokens: [] } };
  });
  vi.spyOn(axios, 'patch').mockImplementation(async (url, raw) => {
    expect(url).toBe(`${serverUrl}/v2/sessions/${sessionId}`);
    const patch = SessionMetadataTuplePatchV1Schema.parse(raw);
    if (metadataPrivacyRefused) return { status: 409, data: {
      error: 'Session metadata privacy upgrade required', code: 'metadata_privacy_upgrade_required',
    } };
    if (patch.mode === 'owner_migration') {
      expect(patch.source.metadata.version).toBe(metadataVersion);
      expect(patch.source.metadata.ciphertext).toBe(metadata);
      metadata = patch.target.sharedMetadata.ciphertext;
      ownerMetadata = patch.target.ownerMetadata;
      agentState = patch.target.agentState.ciphertext;
    } else if (patch.mode === 'owner') {
      expect(patch.sharedMetadata.expectedVersion).toBe(metadataVersion);
      expect(patch.expectedOwnerMetadata).toEqual(ownerMetadata);
      metadata = patch.sharedMetadata.ciphertext;
      ownerMetadata = patch.ownerMetadata;
      agentState = patch.agentState.ciphertext;
    } else throw new Error('Expected real owner tuple mutation');
    metadataLayoutVersion = 1;
    metadataVersion += 1;
    agentStateVersion += 1;
    return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: metadataVersion }, agentState: { version: agentStateVersion } }) };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw, config) => {
    const body: unknown = raw;
    if (url === `${serverUrl}/v1/artifacts`) {
      if (!body || typeof body !== 'object') throw new Error('Invalid artifact request');
      const id = String(Reflect.get(body, 'id'));
      artifacts.set(id, { ...body, id, ownerAccountId: 'alert-account', access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      notifyApprovalCreated(id);
      return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
    }
    const artifact = artifacts.get(url.split('/').at(-1)!);
    if (artifact) {
      if (!body || typeof body !== 'object') throw new Error('Invalid artifact CAS');
      expect(Reflect.get(body, 'expectedHeaderVersion')).toBe(artifact.headerVersion);
      expect(Reflect.get(body, 'expectedBodyVersion')).toBe(artifact.bodyVersion);
      const headerVersion = Number(artifact.headerVersion) + 1;
      const bodyVersion = Number(artifact.bodyVersion) + 1;
      artifacts.set(String(artifact.id), { ...artifact, header: Reflect.get(body, 'header'), body: Reflect.get(body, 'body'), headerVersion, bodyVersion });
      return { status: 200, data: { success: true, headerVersion, bodyVersion } };
    }
    // Home can retire executable Session custody while its signed Account proposal remains unchanged.
    if (url.endsWith('/settings.set/execution-authorization/verify')
      && retiredApprovalRequestId !== undefined && rootRequestIds.get('settings.set') === retiredApprovalRequestId)
      return { status: 401, data: { error: 'invalid_token' } };
    if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (url.endsWith('/execution-authorization')) {
      const actionId = url.split('/').at(-2)!;
      const request = externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId).parse(raw);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
      if (!envelope.requestId) throw new Error('Missing root request identity');
      rootRequestIds.set(actionId, envelope.requestId);
      return { status: 200, data: { v: 1, token: 'alert-home-proof', binding: {
        serverIdentityId: 'srv_alert', accountId: 'alert-account', custodianAccountId: 'alert-account',
        authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', machineId,
        installationId: 'alert-installation', actionId, requestId: envelope.requestId, target: envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } } };
    }
    expect([`Bearer ${credentials.token}`, `Bearer ${decidingCredentials.token}`]).toContain(config?.headers?.Authorization);
    expect(url).toBe(`${serverUrl}/v2/account/settings`);
    const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
    if (conflict) {
      conflict = false;
      content = { t: 'plain', v: { actionsSettingsV1: policy, favoriteMachines: ['concurrent'], futureSetting: 'preserved',
        sessionReplayMaxSeedChars: 1024, machineOfflineAlertsV1: { machineIds: ['peer', 'concurrent'] } } };
      version += 1;
      return { status: 200, data: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: content } };
    }
    expect(request.expectedVersion).toBe(version);
    if (!request.content) throw new Error('Missing Account settings content');
    content = request.content;
    version += 1;
    return { status: 200, data: { success: true, version } };
  });
  const command = 'node /runtime/.runner-snapshots/offline-alert/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23346, processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:offline-alert' };
  processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({ v: 1,
      pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' }) };
  let accountExecutor: ReturnType<typeof createCliActionExecutorFromCredentials> | undefined;
  const execute = createDaemonSessionAccountActionExecutor({ credentials, token: credentials.token,
    serverId, serverHttpBaseUrl: serverUrl, machineId,
    prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, isCallerCurrent, authority }) => {
      const target = { kind: 'machine' as const, machineId };
      const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: operation.actionId,
        input: operation.input, requestId: operation.requestId, target, machineId, sourceMachineId: machineId,
        accountId: 'alert-account', accountEncryptionMode: 'plain', tokenEpochHint: 0, token: credentials.token,
        serverId, serverIdentityId: 'srv_alert', serverHttpBaseUrl: serverUrl, installationId: 'alert-installation',
        privateKey: keys.secretKey, sessionActionOrigin, isCurrent: isCallerCurrent, signal: authority.signal });
      return authorization ? { authorization, target } : null;
    },
    createExecutor: (getCurrentTurnWorkDepth, isCallerCurrent) => {
      const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId,
        serverId, serverApiUrl: serverUrl,
        isSessionCallerCurrent: async ({ caller }) => sessionCallerCurrent && caller.sessionId === sessionId && await isCallerCurrent() });
      if (!currentness) throw new Error('Missing canonical approval currentness');
      accountExecutor = createCliActionExecutorFromCredentials({ credentials,
      serverId, serverApiUrl: serverUrl, serverIdentityId: 'srv_alert', machineId,
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'alert-installation',
      isApprovalExecutionOriginCurrent: currentness,
      getCurrentTurnWorkDepth, readCredentials: async () => credentials, pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
        getAccountSettings: () => accountSettingsParse(content.t === 'plain' ? content.v : {}) }) });
      return accountExecutor;
    },
  });
  const serviceRequests: string[] = [];
  const witness = { turnId: 'alert-turn', inputId: 'alert-input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'default' as const,
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 1, turnDepth: 2 } };
  const tracked: TrackedSession = { startedBy: 'daemon', pid: runner.pid, sessionRunnerPid: runner.pid,
    happySessionId: sessionId, processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
    runnerAgentSourceCustodyV1: authority.retainedAgent.sourceCustody,
    runnerAgentInvocationContext: { cwd: '/workspace', environment: {}, providerBindingActive: false },
    agentRuntimeDaemonServiceAuthorityFilePath: path,
    agentRuntimeDaemonServiceCapabilityHash: hashPrivateBearer('A'.repeat(43)),
    agentRuntimeDaemonServiceAdmittedTurnId: witness.turnId, agentRuntimeDaemonServiceAdmittedInputId: witness.inputId,
    agentRuntimeDaemonServiceAdmittedUserMessageSeq: 1, agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [1] };
  let holdTitle = false;
  let titleEntered!: () => void;
  let releaseTitle!: () => void;
  const titleEntry = new Promise<void>(resolve => { titleEntered = resolve; });
  const titleRelease = new Promise<void>(resolve => { releaseTitle = resolve; });
  // Real private HTTP, with a shortened platform default to expose its hidden
  // headers cutoff without making every regression run wait five minutes.
  const previousDispatcher = getGlobalDispatcher();
  const platformDispatcher = new Agent({ headersTimeout: 25, bodyTimeout: 25 });
  setGlobalDispatcher(platformDispatcher);
  const service = createDaemonControlApp({ getChildren: () => [tracked], machineId,
    stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId }),
    requestShutdown() {}, onHappySessionWebhook() {}, controlToken: 'A'.repeat(43),
    externalActionApi: { currentServerId: serverId, currentAccountId: 'alert-account',
      verifyPat: async () => { throw new Error('Private CLI ingress must not use PAT verification'); },
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverUrl }),
      executor: { execute: async (...args) => {
        if (!accountExecutor) throw new Error('Missing composed daemon executor');
        return accountExecutor.execute(...args);
      } } },
    agentRuntimeDaemonServices: { dispatch: async (raw, context) => {
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(raw);
      if (request.operation.kind !== 'action.execute') throw new Error('Unexpected private request');
      serviceRequests.push(request.operation.actionId);
      if (serviceRequests.length === 1) await new Promise(resolve => setTimeout(resolve, 1_500));
      if (holdTitle && request.operation.actionId === 'session.title.set') { titleEntered(); await titleRelease; }
      const outcome = await execute(request.operation, context);
      return AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
        result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
    } },
  });
  await service.listen({ port: 0, host: '127.0.0.1' });
  const address = service.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing private service address');
  vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid, httpPort: address.port,
    controlToken: 'A'.repeat(43), startedAt: 1, startedWithCliVersion: 'test' });
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: address.port, capability: 'A'.repeat(43) });
  vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
  const runtime = createHappierMcpServer({ sessionId, updateMetadata() {}, getServerBinding: () => ({ serverId, serverUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    getMetadataSnapshot: () => createTestMetadata({ machineId }), getWorkDepth: () => 1, getHostTurnWorkDepth: () => 2,
    getPermissionMode: () => 'default', getActiveTurnAdmissionWitness: () => witness,
    getActiveTurnPermissionWitness: () => ({ turnId: witness.turnId, causalPermissionAuthority: witness.causalPermissionAuthority }),
    getStoredContentEncryptionContext: () => ({ mode: 'plain' }) }, {
      authorityScope: 'session', credentials: null,
      sessionCredentials: { token: 'restricted-runner-session-bearer', encryption: null },
      accountSettings: accountSettingsParse({ actionsSettingsV1: policy }),
    });
  const client = new Client({ name: 'offline-alert-agent', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (actionId: 'settings.get' | 'settings.set', input: unknown): Promise<ActionExecuteResult> => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
    const block = result.content.find(item => item.type === 'text');
    if (!block || block.type !== 'text') throw new Error('Missing MCP Action result');
    const value: unknown = JSON.parse(block.text);
    return result.isError ? ActionExecuteFailureSchema.parse({ ok: false, ...(value !== null && typeof value === 'object' ? value : {}) })
      : { ok: true, result: value };
  };
  try {
    const anchor = 'notifications.machineOffline';
    const enabled = await call('settings.set', { anchor, key: machineId, value: true });
    expect(enabled).toEqual({ ok: true, result: { anchor, value: true } });
    if (!enabled.ok) throw new Error('Expected enabled preference');
    expect(SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(enabled.result)).toEqual(enabled.result);
    expect(await call('settings.get', { anchor, key: machineId })).toEqual({ ok: true, result: { anchor, value: true } });
    expect(content).toMatchObject({ t: 'plain', v: { favoriteMachines: ['concurrent'], futureSetting: 'preserved',
      machineOfflineAlertsV1: { machineIds: ['peer', 'concurrent', machineId] } } });
    expect(deriveAccountRemoteAlertPolicyV1(content.t === 'plain' ? content.v : {})).toMatchObject({ machineOffline: { machineIds: ['peer', 'concurrent', machineId] }, events: { machine_offline: { enabled: true } } });
    expect(await call('settings.set', { anchor, key: machineId, value: 'true' })).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    expect(await call('settings.get', { anchor })).toMatchObject({ ok: false, errorCode: 'setting_key_required' });
    expect(await call('settings.set', { anchor, key: machineId, value: false })).toEqual({ ok: true, result: { anchor, value: false } });
    expect(await call('settings.get', { anchor, key: machineId })).toEqual({ ok: true, result: { anchor, value: false } });
    expect(content).toMatchObject({ t: 'plain', v: { machineOfflineAlertsV1: { machineIds: ['peer', 'concurrent'] } } });
    expect(serviceRequests).toEqual(['settings.set', 'settings.get', 'settings.set', 'settings.get', 'settings.set', 'settings.get']);

    // The normal Agent policy asks first. A prompt's consent cannot waive it.
    if (content.t !== 'plain') throw new Error('Expected plain Account fixture');
    content = { t: 'plain', v: { ...content.v, actionsSettingsV1: { v: 1 } } };
    version += 1;
    let settled = false;
    const pending = call('settings.set', { anchor, key: machineId, value: true }).then(result => { settled = true; return result; });
    void pending.catch(() => undefined); // Closing MCP during a failed assertion rejects the outstanding call.
    await vi.waitFor(() => expect(artifacts.size > 0 || settled).toBe(true));
    if (artifacts.size === 0) expect(await pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const artifactId = await approvalCreated;
    const store = runWithServerHttpBaseUrl(serverUrl, () => createCliApprovalsArtifactStore({ credentials, serverId }));
    const open = await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId, serverId }));
    if (!open) throw new Error('Missing real approval');
    expect(open).toMatchObject({ status: 'open', actionId: 'settings.set' });
    if (!accountExecutor) throw new Error('Missing real Account executor');
    // A person's standalone CLI decision has Account credentials, not the
    // originating runner's live-custody callback. Exercise that real factory.
    expect(await call('settings.get', { anchor, key: machineId })).toEqual({ ok: true, result: { anchor, value: false } });
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(settled).toBe(false);
    // Advance the clock beyond QA16's 20m46s hold without adding a deadline.
    const delayedNow = Date.now() + 21 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(delayedNow);
    if (content.t !== 'plain') throw new Error('Expected plain settings');
    content = { t: 'plain', v: { ...content.v, favoriteMachines: ['during-approval'] } };
    version += 1;
    if (installationChanged) currentInstallationId = 'replacement-installation';
    // The recorded Account proposal survives retirement of live runner custody.
    sessionCallerCurrent = false;
    if (open.v !== 2) throw new Error('Expected canonical approval origin');
    retiredApprovalRequestId = open.executionOriginV1.requestId;
    machineRpc.mockImplementation((event, args) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      const [raw, callback] = args;
      if (!raw || typeof raw !== 'object' || typeof callback !== 'function') throw new Error('Invalid Machine RPC');
      callback({ ok: false, error: 'Machine offline' });
    });
    const output = captureConsoleJsonOutput();
    let decision: unknown;
    try {
      await runWithServerHttpBaseUrl(serverUrl, () => handleActionsCommand(['invoke', 'approval.request.decide',
        '--input-json', JSON.stringify({ artifactId, decision: 'approve' }), '--json'], {
        readCredentialsFn: async () => decidingCredentials,
        getServerProfileFn: async () => ({ id: serverId, name: 'Alert Home', serverUrl, createdAt: 1, updatedAt: 1 }),
        createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
          pluginActionExecutionOwner: 'current_process',
          actionsSettingsProvider: createActionSettingsProvider({ scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
            getAccountSettings: () => accountSettingsParse(content.t === 'plain' ? content.v : {}) }) }),
      }));
      decision = output.json();
    } finally { output.restore(); process.exitCode = 0; }
    expect(decision).toMatchObject({ ok: true, data: { status: installationChanged ? 'failed' : 'approved' } });
    expect(await pending).toMatchObject(installationChanged
      ? { ok: false, errorCode: 'approval_stale' } : { ok: true, result: { anchor, value: true } });
    expect(await runWithServerHttpBaseUrl(serverUrl, () => store.approvalsGet({ artifactId, serverId })))
      .toMatchObject({ status: installationChanged ? 'failed' : 'executed' });
    currentInstallationId = 'alert-installation';
    expect(await call('settings.get', { anchor, key: machineId })).toEqual({ ok: true, result: { anchor, value: !installationChanged } });
    expect(content).toMatchObject({ t: 'plain', v: { favoriteMachines: ['during-approval'] } });
    clock.mockRestore();

    // Account mode/content disagreement cannot turn into a plain mutation.
    content = { t: 'plain', v: { ...content.v, actionsSettingsV1: policy } };
    version += 1;
    accountMode = 'e2ee';
    const beforeRefusal = structuredClone(content);
    expect(await call('settings.set', { anchor, key: machineId, value: false }))
      .toMatchObject({ ok: false, errorCode: 'account_settings_locked' });
    expect(content).toEqual(beforeRefusal);
    accountMode = 'plain';

    // Native Codex can complete a turn while its MCP call is still in flight.
    // The admitted Action must retain its runner custody and write its title.
    holdTitle = true;
    const pendingTitle = client.callTool({ name: 'change_title', arguments: { title: 'Delayed title' } });
    await titleEntry;
    clearTrackedRunnerAgentDaemonServiceAdmission(tracked);
    releaseTitle();
    const completedTitle = CallToolResultSchema.parse(await pendingTitle);
    const completedTitleText = completedTitle.content.find(item => item.type === 'text');
    if (!completedTitleText || completedTitleText.type !== 'text') throw new Error('Missing title result');
    expect(JSON.parse(completedTitleText.text)).toMatchObject({ success: true });
    expect(completedTitle.isError).not.toBe(true);
    const titleReadback = await fetchSessionById({ reason: 'session-control', token: credentials.token, serverUrl, sessionId });
    expect(titleReadback?.metadataLayoutVersion).toBe(1);
    expect(JSON.parse(String(titleReadback?.metadata))).toMatchObject({ summary: { text: 'Delayed title' } });
    // A fresh invocation with the ended witness still refuses at admission.
    expect(await call('settings.get', { anchor, key: machineId })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    Object.assign(tracked, { agentRuntimeDaemonServiceAdmittedTurnId: witness.turnId,
      agentRuntimeDaemonServiceAdmittedInputId: witness.inputId, agentRuntimeDaemonServiceAdmittedUserMessageSeq: 1,
      agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [1] });
    holdTitle = false;

    const secondTitle = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Current tuple title' } }));
    expect(secondTitle.isError).not.toBe(true);
    expect(JSON.parse(String((await fetchSessionById({ reason: 'session-control', token: credentials.token, serverUrl, sessionId }))?.metadata)))
      .toMatchObject({ summary: { text: 'Current tuple title' } });
    metadataPrivacyRefused = true;
    const privacyTitle = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Refused title' } }));
    const privacyText = privacyTitle.content.find(item => item.type === 'text');
    if (!privacyText || privacyText.type !== 'text') throw new Error('Missing title refusal');
    expect(JSON.parse(privacyText.text)).toMatchObject({ errorCode: 'metadata_privacy_upgrade_required' });
    metadataPrivacyRefused = false;

    // A real currentness refusal cannot start a second metadata write.
    currentnessAvailable = false;
    const title = CallToolResultSchema.parse(await client.callTool({ name: 'change_title', arguments: { title: 'Offline alert' } }));
    const titleText = title.content.find(item => item.type === 'text');
    if (!titleText || titleText.type !== 'text') throw new Error('Missing title result');
    expect(JSON.parse(titleText.text)).toMatchObject({ errorCode: 'server_unreachable' });
    expect(JSON.parse(metadata)).toMatchObject({ summary: { text: 'Current tuple title' } });
    expect(content).toEqual(beforeRefusal);
  } finally {
    await client.close();
    await runtime.mcp.close();
    setGlobalDispatcher(previousDispatcher);
    releaseTitle();
    service.server.closeAllConnections();
    await service.close();
    await platformDispatcher.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('A'.repeat(43)) });
  }
});
