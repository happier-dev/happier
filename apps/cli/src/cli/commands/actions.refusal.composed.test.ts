import axios from 'axios';
import { createProviderErrorV1, encodePlainMachineStoredContent, FeaturesResponseSchema } from '@happier-dev/protocol';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1, sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { AccountSettingsV2HistoryListResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { writeCredentialsTokenOnly } from '@/persistence';
import { configuration } from '@/configuration';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { buildChildExitBeforeWebhookFailure } from '@/daemon/spawn/childStderrDiagnostic';
import { projectDaemonServiceRefusalCause } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { PROVIDER_BROKER_CARRIER_OPEN_PHASE } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { buildProviderSpawnErrorResult } from '@/daemon/spawn/buildProviderSpawnErrorResult';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { afterEach, beforeEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { rethrowRequesterHomeReadFailure } from '@/daemon/sessionEncryption/requesterCurrentness';
import { ApprovalExecutionV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createRpcCallError } from '@happier-dev/protocol/rpc/errors';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { SESSION_MCP_CONTEXT_FILE_ENV } from '@/mcp/runtime/sessionMcpLocalContext';
import { installAxiosFastifyAdapter, installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import Fastify from 'fastify';
import { registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { handleActionsCommand } from './actions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SESSION_HANDOFF_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { SESSION_HANDOFF_SOURCE_EXPORT_FAILURE_CODE, SessionHandoffSourceExportFailureDetailsV1Schema } from '@happier-dev/protocol/sessions/control/handoff/handoffStatus';
import { OpenProjectRefusalV1Schema } from '@happier-dev/protocol/projects/openProjectRefusalV1';
import { computeWorkspaceSyncPolicyDigest } from '@/workspaces/sync/workspaceSyncTypes';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createHostApprovalOriginCurrentness } from '@/session/actions/approvals/hostOriginCurrentness';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';

let priorExitCode: typeof process.exitCode;
beforeEach(() => {
  priorExitCode = process.exitCode;
  vi.stubEnv(SESSION_MCP_CONTEXT_FILE_ENV, '');
  installAxiosRequestMethodAdapter();
});
afterEach(() => {
  try {
    resetActiveAccountSettingsSnapshotForTests();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.exitCode = priorExitCode;
  }
});

it('accepts existing V2 history and rejects unvalidated diagnostic payloads', () => {
  const execution = { executedAtMs: 1, ok: false, errorCode: 'RPC_FORBIDDEN', error: 'Forbidden' };
  expect(ApprovalExecutionV2Schema.safeParse(execution).success).toBe(true);
  expect(ApprovalExecutionV2Schema.safeParse({ ...execution, failureCause: { phase: 'rpc.admission.machine_admission',
    errorClass: 'UnknownThrownValue', errorCode: 'RPC_FORBIDDEN', httpStatus: null } }).success).toBe(true);
  expect(ApprovalExecutionV2Schema.safeParse({ ...execution, failureCause: { phase: 'rpc.admission.machine_admission',
    errorClass: 'UnknownThrownValue', errorCode: 'RPC_FORBIDDEN', httpStatus: null, privateCredential: 'never-copy' } }).success).toBe(false);
});

it.each(['provider', 'carrier'] as const)('prints a failed spawn with its typed %s refusal through the real CLI Action envelope', async kind => {
  await withConfiguredDaemonTestHome({ prefix: 'cli-provider-spawn-refusal-' }, async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const providerError = createProviderErrorV1('provider_endpoint_unavailable', { connectionId: 'pc_work', machineId: 'machine' });
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: 'srv_cli_provider_refusal' },
        encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } });
    const machine = MachinePublishedRowV1Schema.parse({ id: 'machine', managedMachineRef: null,
      metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
        host: 'fixture', platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier',
      })), metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
      storageMode: 'plain', active: true, revokedAt: null, replacedByMachineId: null,
    });
    const purposeRow = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
      content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null,
        record: emptyConnectedAccountCatalogRecordV1('purposes') }) });
    const { agentId, title, ...agentFacts } = MachineAgentInventoryItemSchema.parse({ agentId: 'codex', title: 'Codex',
      installed: true, version: '1.2.3', latestVersion: null,
      update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'unsupported' },
      platform: { supported: true }, install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] });
    // Home HTTP and the exact daemon RPC/spawn transports are system boundaries;
    // CLI parsing, Action admission, creation and terminal projection stay real.
    const sockets = await createRequesterCurrentnessSocketHarness();
    const httpPaths: string[] = [];
    sockets.server.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.CALL, (packet, ack) => {
        httpPaths.push(`socket:${packet.method}`);
        if (packet.method === `machine:${RPC_METHODS.CAPABILITIES_DETECT}`) {
          ack({ ok: true, result: { protocolVersion: 1, results: {
            [`cli.${agentId}`]: { ok: true, checkedAt: 1, data: agentFacts },
          } } });
        } else ack({ ok: false, error: 'method_not_found' });
      });
    });
    onTestFailed(() => { console.error('Spawn refusal boundary trace:', JSON.stringify(httpPaths)); });
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const path = new URL(url instanceof Request ? url.url : String(url)).pathname;
      httpPaths.push(path);
      return Response.json(path === '/v1/account/profile' ? { id: 'owner' } : features);
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      httpPaths.push(path);
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain', settingsVersion: 0 }) };
      if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 0 } };
      if (path === '/v2/account/settings/history') return { status: 200, data: AccountSettingsV2HistoryListResponseSchema.parse({ snapshots: [] }) };
      if (path === '/v1/account/entity-rows/connected-accounts/purposes') return { status: 200, data: purposeRow };
      if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
      if (path === '/v1/machines/machine') return { status: 200, data: { machine } };
      throw new Error(`Unexpected Home HTTP read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      httpPaths.push(`POST ${path}`);
      if (path === '/v1/home/governance/get') return { status: 200, data: HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }) };
      if (path.endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      throw new Error(`Unexpected Home HTTP write: ${path}`);
    });
    httpPaths.push('stage:persist_credentials');
    await writeCredentialsTokenOnly(credentials);
    httpPaths.push('stage:bootstrap_settings');
    try {
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
    const output = captureStdoutJsonOutput<unknown>();
    const carrierCause = { phase: PROVIDER_BROKER_CARRIER_OPEN_PHASE, errorClass: 'Error',
      errorCode: 'grant_unknown_key', httpStatus: 403 } as const;
    const spawn = vi.fn(async () => {
      httpPaths.push('daemon:spawn');
      return kind === 'provider' ? buildProviderSpawnErrorResult(providerError) : buildChildExitBeforeWebhookFailure({
        pid: 123, code: 1, signal: null,
        failureCause: projectDaemonServiceRefusalCause({
          code: carrierCause.errorCode, message: 'Provider broker carrier refused to open.', failureCause: carrierCause,
        }),
      });
    });
    httpPaths.push('stage:invoke_cli');
    await handleActionsCommand(['invoke', 'session.spawn_new', '--input-json', JSON.stringify({
      creationKey: 'cli-provider-refusal',
      executionTarget: { serverId: configuration.activeServerId, machineId: 'machine' },
      directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2, bindingsByServiceId: {} },
    }), '--yes', '--json'], {
      readCredentialsFn: async () => ({ ...credentials, credentialProvenance: 'stored_session' }),
      createExecutorFn: params => {
        const executor = createCliActionExecutor({ ...params, token: credentials.token,
          credentials: { ...credentials, credentialProvenance: 'stored_session' },
          sessionId: '', mode: 'plain', ctx: null,
          machineActionDirectTargetTransport: { machineId: 'machine', invoke: async method => {
            httpPaths.push(`daemon:${method}`);
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
              return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
                v: 2, generation: 1, familiesById: {}, agentsById: { [agentId]: { id: agentId, title,
                  capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
              } });
            }
            if (method === RPC_METHODS.CAPABILITIES_DETECT) {
              return { protocolVersion: 1, results: { [`cli.${agentId}`]: { ok: true, checkedAt: 1, data: agentFacts } } };
            }
            throw new Error(`Unexpected daemon RPC: ${method}`);
          } },
          sessionSpawnDirectTargetTransport: { machineId: 'machine',
            prepare: async () => { httpPaths.push('daemon:prepare'); return { ok: true, directory: '/workspace', directoryKind: 'managed', directoryCreationRequired: false, checkout: null }; },
            spawnedSession: { spawn, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
        });
        return { ...executor,
          resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } };
      },
    });
    httpPaths.push('stage:cli_settled');
    expect(spawn, JSON.stringify({ output: output.json(), httpPaths })).toHaveBeenCalledOnce();
    expect(output.json(), output.chunks.join('')).toMatchObject({ ok: false, kind: 'actions_invoke', error: {
      code: 'spawn_failed', ...(kind === 'provider'
        ? { details: { type: 'error', code: 'spawn_failed', retryable: providerError.retryable, providerError } }
        : { failureCause: carrierCause }),
    } });
    expect(process.exitCode).toBe(1);
    } finally { await sockets.close(); }
  });
});

it.each(['native_refusal', 'raw_rpc', 'raw_rpc_text', 'requester_home', 'requester_home_text'] as const)('prints %s failureCause and the owning effect fact after real approval settlement and public read', async transport => {
  await withConfiguredDaemonTestHome({ prefix: 'cli-refusal-projection-' }, async () => {
  const sockets = await createRequesterCurrentnessSocketHarness();
  sockets.server.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.REGISTER, packet => socket.emit(SOCKET_RPC_EVENTS.REGISTERED, packet));
    socket.on(SOCKET_RPC_EVENTS.CALL, (packet, ack) => {
      socket.emit(SOCKET_RPC_EVENTS.REQUEST, { ...packet, callerAuthority: 'present_user' },
        (result: unknown) => ack({ ok: true, result }));
    });
  });
  try {
  const endpoint = sockets.serverUrl;
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
    encryption: null, credentialProvenance: 'stored_session' as const };
  const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: 'srv_cli_refusal' } } });
  vi.stubGlobal('fetch', async () => Response.json(features));
  const home = Fastify();
  registerPlainArtifactRoutes(home, 'owner');
  const createdArtifactIds: string[] = [];
  home.addHook('preHandler', async request => {
    if (request.method === 'POST' && request.url === '/v1/artifacts') {
      createdArtifactIds.push(ArtifactJsonCreateHttpInputV1Schema.parse(request.body).id);
    }
  });
  home.get('/v1/account/profile', async () => ({ id: 'owner' }));
  home.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
  home.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: endpoint });
  onTestFinished(async () => { restoreHttp(); await home.close(); });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  const notices = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
  let effects = 0;
  rpc.registerHandler('demo.effect', () => { effects++; return { revoked: true }; });
  const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
    ['account.apiTokens.revoke']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) },
  } } });
  let executor: ReturnType<typeof createCliActionExecutor> | undefined;
  const requesterHome = transport === 'requester_home' || transport === 'requester_home_text';
  const json = transport !== 'requester_home_text' && transport !== 'raw_rpc_text';
  const requestId = 'cli-refusal-invocation';
  await handleActionsCommand(['invoke', 'account.apiTokens.revoke', '--input-json',
    JSON.stringify({ tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d' }), '--request-id', requestId, '--yes', ...(json ? ['--json'] : [])], {
    readCredentialsFn: async () => credentials,
    createExecutorFn: params => {
      executor = createCliActionExecutor({ ...params, token: credentials.token, credentials,
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: endpoint,
        serverIdentityId: 'srv_cli_refusal', runtimeActionMachineId: 'machine',
        isApprovalExecutionOriginCurrent: createHostApprovalOriginCurrentness({ credentials,
          serverId: 'home', serverApiUrl: endpoint,
          resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: endpoint, token: credentials.token }),
          checkDaemonOrigin: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
            machineId: 'machine', serverId: 'home', serverApiUrl: endpoint }),
        }),
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings, allowEnvironmentOverride: false }),
        // Artifact HTTP and native RPC are the substituted external boundaries.
        accountServerActionDeps: {
    accountApiTokensRevokeAction: async () => {
      if (requesterHome) {
        rethrowRequesterHomeReadFailure({ code: 'ETIMEDOUT' });
      }
      const response = await rpc.handleRequest({ method: 'machine:demo.effect', params: { privateOperand: 'never-copy' },
        callerInputAuthorization: JSON.parse('{"privateCredential":"never-copy"}') });
      if (!response || typeof response !== 'object' || !('error' in response) || typeof response.error !== 'string') {
        throw new Error('Expected RPC admission refusal');
      }
      // Both returned Machine results and thrown RpcErrors preserve the
      // admission owner's explicit no-effect fact through durable settlement.
      if (transport === 'raw_rpc' || transport === 'raw_rpc_text') throw createRpcCallError(response);
      return readMachineActionRpcResult(response);
    },
        },
      });
      return { ...executor, resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } };
    },
  });
  const errorCode = requesterHome ? 'project_requester_home_unavailable' : 'RPC_FORBIDDEN';
  const failureCause = requesterHome
    ? { nativeErrorReason: 'timeout', httpStatus: null }
    : { phase: 'rpc.admission.caller_input_authorization', errorClass: 'UnknownThrownValue', errorCode, httpStatus: null };
  expect(effects).toBe(0);
  expect(notices.mock.calls.flat().join(' '), output).toContain('approval');
  const effect = requesterHome ? {} : { effectAttempted: false };
  expect(createdArtifactIds).toHaveLength(1);
  const artifactId = createdArtifactIds[0]!;
  if (!executor) throw new Error('CLI executor was not composed');
  if (json) {
    expect(JSON.parse(output), output).toMatchObject({ ok: false,
      error: { code: errorCode, failureCause, ...effect } });
  } else {
    const text = notices.mock.calls.flat().join(' ');
    expect(text).toContain(errorCode);
    expect(text).toContain(requesterHome ? 'requester.home_read' : 'rpc.admission.caller_input_authorization');
    expect(text).toContain(requestId);
    if (requesterHome) expect(text).toContain('timeout');
    else expect(text).toContain('No effect attempted');
    expect(text).not.toContain('never-copy');
  }
  expect(await executor.execute('approval.request.get', { artifactId }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
    .toMatchObject({ ok: true, result: { request: { status: 'failed', execution: { ok: false, errorCode, failureCause, ...effect } } } });
  expect(output).not.toContain('never-copy');
  expect(process.exitCode).toBe(1);
  } finally { await sockets.close(); }
  });
});

it.each(['source export', 'private checkout'] as const)('prints the closed %s refusal from the Session handoff Action', async kind => {
  const checkout = kind === 'private checkout';
  const requestId = 'cli-handoff-refusal';
  const checkoutCode = 'workspace_private_checkout_review_required';
  const failureCause = {
    phase: 'session.handoff.workspace_capture',
    errorClass: 'Error',
    errorCode: checkoutCode,
    httpStatus: null,
    nativeErrorReason: checkoutCode,
  };
  const refusal = checkout ? {
    errorCode: checkoutCode,
    error: 'The destination needs a private checkout.',
    failureCause,
    effectAttempted: false,
    details: OpenProjectRefusalV1Schema.parse({
      kind: 'refused', code: checkoutCode, failureCause, effectAttempted: false,
      destinationReview: { accountId: 'member', serverId: 'home', machineId: 'target-machine',
        destinationParentPath: '/members/workspaces', destinationDirectoryName: 'copy' },
    }),
  } : {
    errorCode: SESSION_HANDOFF_SOURCE_EXPORT_FAILURE_CODE,
    error: 'Failed to export Session state',
    details: SessionHandoffSourceExportFailureDetailsV1Schema.parse({
      diagnostics: [{ code: 'transcript_missing', details: { pathKind: 'transcript_file' } }],
    }),
  };
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const workspaceAction = checkout
    ? { kind: 'copy_once', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } }
    : { kind: 'none' };
  const notices = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sourceReply = vi.fn(async ({ actionRequestId }: { actionRequestId?: string }) => ({
    ok: false as const,
    ...refusal,
    requestId: actionRequestId,
  }));
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    // Keep the real Action admission; the two remote daemons answer preflight and start.
    sessionHandoffTargetReplacementApprovalPreflight: async () => ({ type: 'not_required' }),
    sessionHandoffStart: sourceReply,
  });
  await handleActionsCommand(['invoke', SESSION_HANDOFF_ACTION_ID_V1, '--input-json',
    JSON.stringify({ sessionId: 'source-session', targetMachineId: 'target-machine', workspaceAction }),
    '--request-id', requestId, '--yes'], {
    readCredentialsFn: async () => ({ token: 'fixture', encryption: null, credentialProvenance: 'stored_session' }),
    createExecutorFn: () => ({ ...executor,
      resolveSessionTarget: async sessionId => ({ ok: true, sessionId }) }),
  });
  const terminal = notices.mock.calls.flat().join(' ');
  expect(sourceReply, terminal).toHaveBeenCalledOnce();
  expect(terminal).toContain(requestId);
  if (checkout) {
    expect(terminal).toContain(checkoutCode);
    expect(terminal).toContain(failureCause.phase);
    expect(terminal).toContain('No effect attempted');
  } else {
    expect(terminal).toContain('transcript_missing');
    expect(terminal).toContain('transcript_file');
  }
  expect(process.exitCode).toBe(1);
});
