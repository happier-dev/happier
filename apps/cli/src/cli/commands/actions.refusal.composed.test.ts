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
import { buildProviderSpawnErrorResult } from '@/daemon/spawn/buildProviderSpawnErrorResult';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { afterEach, beforeEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
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

it('prints a failed spawn with its typed Provider refusal through the real CLI Action envelope', async () => {
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
    const spawn = vi.fn(async () => { httpPaths.push('daemon:spawn'); return buildProviderSpawnErrorResult(providerError); });
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
      code: 'spawn_failed', details: { type: 'error', code: 'spawn_failed', retryable: providerError.retryable, providerError },
    } });
    expect(process.exitCode).toBe(1);
    } finally { await sockets.close(); }
  });
});

it.each(['native_refusal', 'raw_rpc'] as const)('prints %s failureCause and the owning effect fact after real approval settlement and public read', async transport => {
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
  await handleActionsCommand(['invoke', 'account.apiTokens.revoke', '--input-json',
    JSON.stringify({ tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d' }), '--yes', '--json'], {
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
      const response = await rpc.handleRequest({ method: 'machine:demo.effect', params: { privateOperand: 'never-copy' },
        callerInputAuthorization: JSON.parse('{"privateCredential":"never-copy"}') });
      if (!response || typeof response !== 'object' || !('error' in response) || typeof response.error !== 'string') {
        throw new Error('Expected RPC admission refusal');
      }
      // Both returned Machine results and thrown RpcErrors preserve the
      // admission owner's explicit no-effect fact through durable settlement.
      if (transport === 'raw_rpc') throw createRpcCallError(response);
      return readMachineActionRpcResult(response);
    },
        },
      });
      return { ...executor, resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } };
    },
  });
  const failureCause = { phase: 'rpc.admission.caller_input_authorization', errorClass: 'UnknownThrownValue',
    errorCode: 'RPC_FORBIDDEN', httpStatus: null };
  expect(effects).toBe(0);
  expect(notices.mock.calls.flat().join(' '), output).toContain('approval');
  const effectAttempted = false;
  expect(createdArtifactIds).toHaveLength(1);
  const artifactId = createdArtifactIds[0]!;
  if (!executor) throw new Error('CLI executor was not composed');
  expect(JSON.parse(output), output).toMatchObject({ ok: false,
    error: { code: 'RPC_FORBIDDEN', failureCause, effectAttempted } });
  expect(await executor.execute('approval.request.get', { artifactId }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
    .toMatchObject({ ok: true, result: { request: { status: 'failed', execution: { ok: false, errorCode: 'RPC_FORBIDDEN', failureCause, effectAttempted } } } });
  expect(output).not.toContain('never-copy');
  expect(process.exitCode).toBe(1);
  } finally { await sockets.close(); }
  });
});
