import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { join } from 'node:path';

import { io, type Socket } from 'socket.io-client';
import { expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResultSchema, CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  accountSettingsParse,
  ConnectedAccountAttemptResponseSchema,
  ConnectedAccountDaemonControlResponseSchema,
  CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
  CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
  encodeBase64,
  signMachineInstallationProof,
  McpServerCatalogSnapshotV1Schema,
  buildAccountStoredContentCompatibilitySocketAuthV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { ConnectedAccountPeerOperationTransportSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { MCP_OAUTH_CALLBACK_URL_V1, MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { executeConnectedServiceConfigurationActionV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';

import { createConnectedAccountSocketHome } from '../../../../server/sources/testkit/connectedAccountSocketHome.testkit.mjs';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiClient } from '@/api/api';
import * as persistenceBoundary from '@/persistence';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { registerMachineConnectedAccountRpcHandlers } from '@/api/machine/rpcHandlers.connectedAccounts';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonMcpServersTestResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { McpServerToolsSnapshotV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { beginActiveMcpServerCatalogRefresh, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { refreshActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { readQualifiedConnectedAccountCredentialV4, listQualifiedConnectedAccountsV4,
  listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4,
  acquireQualifiedConnectedAccountRefreshLeaseV4, mutateQualifiedConnectedAccountCredentialV4,
  mutateQualifiedConnectedAccountCredentialHealthV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation,
  resolveQualifiedConnectedAccountRemovalReviewNegotiation,
  resolveQualifiedConnectedAccountPeerClass,
  resolveQualifiedConnectedAccountPeerOperationTransport } from '@/api/client/qualifiedConnectedAccountApi';
import { fetchServerFeaturesSnapshot, readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createConnectedAccountDaemonRuntime } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import { createQualifiedConnectedAccountDaemonPersistence, createAccountSettingsConnectedAccountSecrets } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from '@/daemon/connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { createDaemonQualifiedRequestAuthCallbacks } from '@/daemon/connectedServices/requestAuth/createDaemonQualifiedRequestAuthCallbacks';
import { createDaemonMcpRequestAuthForTest, type IssueMcpTestRequestAuth } from '@/daemon/connectedServices/requestAuth/createDaemonMcpRequestAuthForTest';
import { ConnectedServiceRefreshCoordinator } from '@/daemon/connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { applyConnectedAccountRequestAuthRecovery, refreshExpiredConnectedAccountRequestAuthReplacement } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthRecovery';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { issueMcpRequestAuthCapability } from '@/mcp/runtime/issueMcpRequestAuthCapability';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import * as mcpExecutableBoundary from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { createEphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';
import { createDaemonMachineBootstrapRuntime } from '@/daemon/startup/createDaemonMachineBootstrapRuntime';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '@/daemon/serverWork';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createCliMcpServerActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliMcpServerActionDeps';
import { createCliConnectedServiceAction } from '@/session/actions/connectedServiceActionDeps';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';

const cleanup: Array<() => Promise<unknown>> = [];
let preparedHome: Awaited<ReturnType<typeof createConnectedAccountSocketHome>> | null = null;

/** Database deployment belongs to fixture setup, outside the finite RPC journey. */
export async function prepareMcpOAuthSocketRequestAuthFixture(options?: Readonly<{ encryptionMode?: 'plain' | 'e2ee' }>): Promise<void> {
  preparedHome = await createConnectedAccountSocketHome(options);
  const home = preparedHome;
  cleanup.push(() => home.close());
}

export async function closeMcpOAuthSocketRequestAuthFixture(): Promise<void> {
  preparedHome = null;
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, 'Composed MCP OAuth fixture cleanup failed');
}

async function connect(socket: Socket) {
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
}

export async function exerciseMcpOAuthSocketRequestAuth(options?: Readonly<{ testPipeline?: boolean; ownClient?: boolean }>): Promise<void> {
  if (!preparedHome) await prepareMcpOAuthSocketRequestAuthFixture();
  const harness = preparedHome!;
  preparedHome = null;
  const homeAccount = { id: harness.accountId };
  const token = harness.token;
  const credentials = { token, encryption: harness.encryption };
  if (options?.testPipeline) {
    vi.spyOn(persistenceBoundary, 'readStoredCredentials').mockResolvedValue(credentials);
  }
  // Executable resolution is the process boundary. Keep the real materializer,
  // probe and bridge while choosing the current source entrypoint for this run.
  const resolveExecutable = mcpExecutableBoundary.resolveNodeBackedMcpServerCommand;
  vi.spyOn(mcpExecutableBoundary, 'resolveNodeBackedMcpServerCommand').mockImplementation(
    input => resolveExecutable({ ...input, preferSourceEntrypoint: true }));
  const keys = harness.keys;
  const installationId = harness.installationId;
  const machine = { id: harness.machineId };
  const homeUrl = harness.baseUrl;
  const currentAccountStoredContentCompatibilitySocketAuth = buildAccountStoredContentCompatibilitySocketAuthV1(
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION);
  const unpublish = publishServerHttpRuntimeOrigin(homeUrl, 'https');
  cleanup.push(async () => unpublish());
  const featuresSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: homeUrl, token });
  expect(featuresSnapshot.status).toBe('ready');
  expect(readServerIdentityIdFromFeaturesSnapshot(featuresSnapshot)).toEqual(expect.any(String));
  expect(resolveQualifiedConnectedAccountAtomicV4Negotiation(featuresSnapshot)).toBe('advertised');

  const tls = await createEphemeralTlsServerFixture();
  cleanup.push(() => tls.cleanup());
  let acceptedToken = 'access-1';
  let acceptedTokenExpiresAt = Number.POSITIVE_INFINITY;
  let nextTokenExpiresIn = 3600;
  let delayedAuthenticationFailures: { releases: Array<() => void>; ready(): void } | null = null;
  let failNextRequest = false;
  let failToolsDiscovery = false;
  const bearerRequests: string[] = [];
  const upstreamRequests: Array<{ method: string | undefined; path: string | undefined; authenticated: boolean }> = [];
  const mcpHttp = createSecureServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) });
  mcpHttp.on('request', async (request, response) => {
    bearerRequests.push(request.headers.authorization ?? '');
    upstreamRequests.push({ method: request.method, path: request.url,
      authenticated: request.headers.authorization === `Bearer ${acceptedToken}` });
    if (request.method === 'POST' && delayedAuthenticationFailures && delayedAuthenticationFailures.releases.length < 2) {
      delayedAuthenticationFailures.releases.push(() => {
        response.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' }).end('{}');
      });
      if (delayedAuthenticationFailures.releases.length === 2) delayedAuthenticationFailures.ready();
      return;
    }
    if (failNextRequest || request.headers.authorization !== `Bearer ${acceptedToken}` || Date.now() >= acceptedTokenExpiresAt) {
      failNextRequest = false;
      response.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' }).end('{}');
      return;
    }
    const server = new Server({ name: 'composed-oauth', version: '7.8.9' },
      { capabilities: { tools: {} }, instructions: 'Instructions from the authenticated upstream.' });
    server.setRequestHandler(ListToolsRequestSchema, async request => {
      if (failToolsDiscovery) throw new McpError(-32603, 'Fixture discovery failure');
      return request.params?.cursor === 'second-page'
      ? { tools: [{ name: 'second_page_tool', title: 'Second page', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
      : { tools: [{ name: 'ping', title: 'Ping upstream', inputSchema: { type: 'object' } }], nextCursor: 'second-page' };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>(resolve => mcpHttp.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { mcpHttp.closeAllConnections(); await new Promise<void>(resolve => mcpHttp.close(() => resolve())); });
  const mcpAddress = mcpHttp.address();
  if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('MCP listener unavailable');
  const resource = `https://127.0.0.1:${mcpAddress.port}/mcp`;
  const issuer = 'https://authorization.fixture.test/issuer';
  const authorizationBodies: URLSearchParams[] = [];
  let tokenSequence = 0;
  const as = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    response.setHeader('content-type', 'application/json');
    if (request.url === '/mcp') {
      response.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="https://authorization.fixture.test/prm", scope="read"' }).end('{}');
    } else if (request.url === '/prm') {
      response.end(JSON.stringify({ resource, authorization_servers: [issuer] }));
    } else if (request.url === '/.well-known/oauth-authorization-server/issuer') {
      response.end(JSON.stringify({ issuer, authorization_endpoint: 'https://authorization.fixture.test/authorize',
        token_endpoint: 'https://authorization.fixture.test/token', response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: options?.ownClient !== true,
        authorization_response_iss_parameter_supported: true }));
    } else if (request.url === '/token') {
      authorizationBodies.push(new URLSearchParams(Buffer.concat(body).toString('utf8')));
      tokenSequence++;
      acceptedToken = `access-${tokenSequence}`;
      acceptedTokenExpiresAt = Date.now() + nextTokenExpiresIn * 1000;
      response.end(JSON.stringify({ access_token: acceptedToken, refresh_token: `refresh-${tokenSequence}`,
        token_type: 'Bearer', expires_in: nextTokenExpiresIn, scope: 'read' }));
    } else { response.writeHead(404).end('{}'); }
  });
  await new Promise<void>(resolve => as.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { as.closeAllConnections(); await new Promise<void>(resolve => as.close(() => resolve())); });
  const asAddress = as.address();
  if (!asAddress || typeof asAddress === 'string') throw new Error('Authorization listener unavailable');
  const networkFetch = globalThis.fetch;
  // Only the third-party AS boundary maps logical HTTPS endpoints to real
  // local HTTP. The Home and bridge network transports remain unmodified.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'authorization.fixture.test' || url.href === resource) {
      return networkFetch(`http://127.0.0.1:${asAddress.port}${url.pathname}${url.search}`, init);
    }
    return networkFetch(input, init);
  });

  const controller = createPluginReloadController({ happyHomeDir: join(harness.baseDir, 'daemon') });
  const admitted = await createAdmittedPluginRuntimeFixture({ controller, happyHomeDir: join(harness.baseDir, 'daemon'),
    runtimeOptions: { contributes: createResolvedContributionRegistry({}), pluginIds: [] } });
  cleanup.push(() => admitted.dispose());
  const transactions = createQualifiedConnectedAccountAttemptTransactionAdapters({ credentials,
    getAccountEncryptionMode: async () => harness.encryptionMode, getMachineId: () => machine.id });
  const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials,
    getAccountEncryptionMode: async () => harness.encryptionMode, attemptTransactions: transactions,
    resolveServerFeaturesSnapshot: () => featuresSnapshot,
    secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) }) });
  const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials, reloadController: controller,
    getAccountEncryptionMode: async () => harness.encryptionMode, configuration: persistence.configuration });
  const refreshCoordinator = new ConnectedServiceRefreshCoordinator({ api: await ApiClient.create(credentials), credentials,
    machineIdProvider: () => machine.id, activeServerDir: harness.baseDir, baseDir: join(harness.baseDir, 'materials'),
    // The existing daemon bootstrap owns these current defaults. This fixture
    // does not impose a shorter refresh lease or start a refresh timer.
    refreshWindowMs: 10 * 60_000, refreshLeaseMs: 2 * 60_000, now: Date.now,
    qualifiedConnectedAccountRuntime: { resolvePeerClass: () => resolveQualifiedConnectedAccountPeerClass(featuresSnapshot), establishedRuntimeOwner: established,
      readCredential: readQualifiedConnectedAccountCredentialV4,
      mutateCredentialHealth: mutateQualifiedConnectedAccountCredentialHealthV4,
      acquireRefreshLease: acquireQualifiedConnectedAccountRefreshLeaseV4,
      mutateCredential: mutateQualifiedConnectedAccountCredentialV4 } });
  const runtime = createConnectedAccountDaemonRuntime({ reloadController: controller, persistence,
    resolvePeerOperationTransport: ({ service, operation }) => ConnectedAccountPeerOperationTransportSchema.parse(resolveQualifiedConnectedAccountPeerOperationTransport({
      snapshot: featuresSnapshot, service, operation,
    })),
    configurationConsequences: {
      assertAvailable: async () => {
        if (!refreshCoordinator) throw new Error('connected_account_configuration_consequence_unavailable');
      },
      apply: input => refreshCoordinator.applyQualifiedConnectedAccountConfigurationConsequence(input),
    },
    revocation: { token, establishedRuntimeOwner: established,
      resolveV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(featuresSnapshot),
      resolveRemovalReviewSupport: () => resolveQualifiedConnectedAccountRemovalReviewNegotiation(featuresSnapshot) } });
  cleanup.push(async () => runtime.dispose());

  const machineSocket = io(homeUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
    auth: { token, clientType: 'machine-scoped', machineId: machine.id, installationId,
      installationPublicKey: encodeBase64(keys.publicKey, 'base64url'),
      installationProof: signMachineInstallationProof({ payload: { version: 1, installationId, machineId: machine.id,
        accountId: homeAccount.id }, privateKey: keys.secretKey }),
      ...currentAccountStoredContentCompatibilitySocketAuth } });
  const viewer = io(homeUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
    auth: { token, clientType: 'user-scoped', clientPurpose: 'scoped-rpc', ...currentAccountStoredContentCompatibilitySocketAuth } });
  cleanup.push(async () => { viewer.close(); machineSocket.close(); });
  const machineContent = harness.machineEncryptionKey
    ? { encryptionMode: 'e2ee' as const, encryptionKey: harness.machineEncryptionKey, encryptionVariant: 'dataKey' as const }
    : { encryptionMode: 'plain' as const };
  const machineCodec = createMachineContentCodec(machineContent);
  const rpcContent: SocketRpcContent = machineCodec.mode === 'plain' ? { mode: 'plain' }
    : { mode: 'e2ee', cipher: { encryptRaw: async value => machineCodec.encodeRpc(value), decryptRaw: async value => machineCodec.decodeRpc(value) } };
  const rpc = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id, ...machineContent,
    authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: machine.id,
      resolveCustodianAccountId: async () => homeAccount.id, resolveInstallationId: () => installationId,
      resolveHomeServerIdentityId: async () => readServerIdentityIdFromFeaturesSnapshot(featuresSnapshot) ?? null,
      verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: keys.secretKey,
        daemonToken: token, serverHttpBaseUrl: homeUrl }) }) });
  // Exercise the real registered handler with its runtime temporarily unbound.
  // Restoring this dependency must be necessary for the same journey to succeed.
  let rpcRuntime: typeof runtime | null = null;
  let testAuthBound = false;
  let testIssuer: IssueMcpTestRequestAuth | undefined;
  const testCapabilityPaths: string[] = [];
  if (options?.testPipeline) {
    // Consume the actual daemon bootstrap projection. Registering the finite
    // issuer directly skipped the production hop that can drop it.
    const machineBootstrap = createDaemonMachineBootstrapRuntime({
      api: await ApiClient.create(credentials), credentials, controlPort: 0,
      runtimeId: 'oauth-fixture', publicReleaseChannel: 'dev', startupSource: 'manual', serviceLabel: undefined,
      transferRuntimeStatePublisher: null,
      spawnSessionForInternalResume: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'unused' }),
      spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'unused' }),
      stopSession: async () => ({ status: 'not_found' }), awaitAgentSessionOpen: undefined,
      isSessionAlreadyRunning: async () => false, loadLocalSessionMetadataForHandoff: async () => null,
      beforeShutdown: async () => {}, requestShutdown() {}, directPeerServerLifecycle: null,
      directTransferRegistryHost: createCliRegistryHostV1({ credentials }),
      daemonServerWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
      setDaemonServerWorkOnline() {}, onMachineConnectionOnline: async () => {},
      reconcileConnectedServicesProjection: async () => {}, isShuttingDown: () => false,
      mcpServers: {
        readCredentials: async () => credentials,
        hostHomeServerIdentityId: readServerIdentityIdFromFeaturesSnapshot(featuresSnapshot) ?? undefined,
        serverHttpBaseUrl: homeUrl,
        env: { ...process.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, NODE_OPTIONS: '--conditions=happier-source' },
        issueRequestAuth: async (input, operationContext, context) => {
          if (!testAuthBound || !testIssuer) throw new Error('mcp_request_auth_not_active');
          const capability = await testIssuer(input, operationContext, context);
          testCapabilityPaths.push(capability.capabilityFile);
          return capability;
        },
      },
    });
    const registration = registerMachineRpcHandlers({ rpcHandlerManager: rpc,
      handlers: { spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'unused' }),
        stopSession: async () => true, requestShutdown() {} },
      deps: { currentMachineId: machine.id, mcpServers: machineBootstrap.mcpServers },
    });
    cleanup.push(() => registration.dispose());
  }
  registerMachineConnectedAccountRpcHandlers({ rpcHandlerManager: rpc, machineId: machine.id, getRuntime: () => rpcRuntime });
  machineSocket.on('disconnect', () => rpc.onSocketDisconnect());
  machineSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, ack: (result: unknown) => void) => {
    void rpc.handleRequest(request).then(ack);
  });
  await Promise.all([connect(machineSocket), connect(viewer)]);
  rpc.onSocketConnect(machineSocket);
  // ApiMachineClient owns the current machine-control registration budget
  // (MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS in apiMachine.ts).
  expect(await rpc.waitForRegisteredHandlers([CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ...(options?.testPipeline ? [RPC_METHODS.DAEMON_MCP_SERVERS_TEST] : [])],
    { timeoutMs: 10_000 })).toMatchObject({ status: 'ready' });
  const call = async (method: string, command: unknown, envelope = true) => {
    const fullMethod = `${machine.id}:${method}`;
    const callId = randomUUID().replaceAll('-', '');
    const params = await socketRpcCodec.encodeParams(rpcContent, envelope ? { v: 1, machineId: machine.id, command } : command, { method: fullMethod, callId });
    // ApiMachineClient.machineRpc's current socket call default is 20_000ms.
    const reply = await viewer.timeout(20_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: fullMethod, params });
    expect(reply).toMatchObject({ ok: true });
    return await socketRpcCodec.decodeResult(rpcContent, reply, callId);
  };
  const connectedHost: ConnectedServiceConfigurationActionHostV1 = {
    assertCurrent() {
      if (!viewer.connected || !machineSocket.connected) throw new Error('Connected-account socket custody retired');
    }, request: async () => { throw new Error('Unexpected direct HTTP Action'); },
    mutatePurposeBindings: async () => { throw new Error('Unexpected binding selection'); },
    resolveAgent: async () => null, resetQuota: async () => { throw new Error('Unexpected quota reset'); },
    authenticationCommand: async (_machineId, command) => ConnectedAccountAttemptResponseSchema.parse(
      await call(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, command)),
    controlCommand: async (_machineId, command) => ConnectedAccountDaemonControlResponseSchema.parse(
      await call(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, command)),
  };
  const catalog = McpServerCatalogSnapshotV1Schema.parse({ status: 'ready', authority: 'active', revision: 1, diagnostics: [],
    catalog: { v: 1, bindings: [{ id: 'everywhere', serverId: 'server-one', target: { t: 'allMachines' }, enabled: true,
      createdAt: 1, updatedAt: 1 }], servers: [{ id: 'server-one', name: 'fixture', transport: 'http', env: {},
      remote: { url: resource, headers: {}, auth: { kind: 'oauth' } }, createdAt: 1, updatedAt: 1 }] } });
  if (catalog.status !== 'ready') throw new Error('Canonical MCP catalog fixture unavailable');
  let store: ReturnType<typeof createCliMcpServerStore> | undefined;
  if (options?.testPipeline) {
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
    store = createCliMcpServerStore({ credentials });
    const initial = await refreshActiveMcpServerCatalog({ credentials });
    expect(initial.status).toBe('ready');
    if (initial.status !== 'ready') throw new Error('MCP catalog unavailable');
    expect(await store.mutate({ kind: 'server-create', entry: catalog.catalog.servers[0]!, rules: catalog.catalog.bindings },
      initial.revision)).toMatchObject({ status: 'updated' });
  }
  const snapshot = getActiveAccountSettingsSnapshot();
  const operationContext = options?.testPipeline && snapshot
    ? createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: homeUrl, isCurrent: async () => true })
    : undefined;
  const callMachineAction: Parameters<typeof createCliMcpServerActionExecuteV1>[0]['callMachineAction'] = input =>
    call(input.method, input.request, false);
  const cliExecute = options?.testPipeline && snapshot ? createCliMcpServerActionExecuteV1({ credentials,
    serverId: 'oauth-fixture-home', serverHttpBaseUrl: homeUrl,
    operationContext,
    connectedServiceAction: createCliConnectedServiceAction({ credentials, serverId: 'oauth-fixture-home', serverHttpBaseUrl: homeUrl,
      operationContext, resolveHeaders: () => ({ Authorization: `Bearer ${token}` }), callMachineAction }),
    callMachineAction,
  }) : undefined;
  const execute = cliExecute ?? createMcpServerActionExecuteV1({ readCatalog: async () => catalog,
    mutate: async () => { throw new Error('Unexpected MCP catalog write'); }, machine: async () => { throw new Error('Unexpected MCP test'); },
    resolveAdministrationMachine: async () => machine.id,
    describeConnectedService: (machineId, command) => connectedHost.controlCommand!(machineId, command),
    connectedServiceAction: args => executeConnectedServiceConfigurationActionV1(connectedHost, args.actionId, args.input) });
  expect(await connectedHost.controlCommand!(machine.id, { operation: 'describeService',
    service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, requiredOperation: 'credential_write' }))
    .toMatchObject({ status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' });
  const unavailableSignIn = () => execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server-one' },
    context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      externalActionTarget: { kind: 'machine', machineId: machine.id } } });
  if (cliExecute) {
    expect(await unavailableSignIn()).toMatchObject({ ok: false, errorCode: 'mcp_sign_in_not_supported' });
  } else {
    await expect(unavailableSignIn()).rejects.toMatchObject({ code: 'mcp_sign_in_not_supported' });
  }
  expect(authorizationBodies).toEqual([]);
  rpcRuntime = runtime;
  const begun = await execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server-one',
    ...(options?.ownClient ? { client: { clientId: 'fixture-own-app' } } : {}) },
    context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      externalActionTarget: { kind: 'machine', machineId: machine.id } } });
  expect(begun).toMatchObject({ ok: true });
  if (!begun.ok) throw new Error('Sign-in start failed');
  let attempt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.signIn.start'].parse(begun.result);
  let state = new URL(attempt.authorizationUrl).searchParams.get('state')!;
  expect(state.startsWith(`${attempt.attemptId}.`)).toBe(true);
  const rejected = ConnectedAccountAttemptResponseSchema.parse(await connectedHost.authenticationCommand!(machine.id, { operation: 'completeOAuth', attemptId: attempt.attemptId,
    completion: { code: 'private-code', state, callbackUrl: MCP_OAUTH_CALLBACK_URL_V1, iss: 'https://wrong-issuer.example' } }));
  expect(rejected.status).toBe('rejected');
  expect(authorizationBodies).toEqual([]);
  const restarted = await execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server-one',
    ...(options?.ownClient ? { client: { clientId: 'fixture-own-app' } } : {}) },
    context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      externalActionTarget: { kind: 'machine', machineId: machine.id } } });
  expect(restarted).toMatchObject({ ok: true });
  if (!restarted.ok) throw new Error('Fresh sign-in start failed');
  attempt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.signIn.start'].parse(restarted.result);
  state = new URL(attempt.authorizationUrl).searchParams.get('state')!;
  const completed = await connectedHost.authenticationCommand!(machine.id, { operation: 'completeOAuth', attemptId: attempt.attemptId,
    completion: { code: 'private-code', state, callbackUrl: MCP_OAUTH_CALLBACK_URL_V1, iss: issuer } });
  expect(completed).toMatchObject({ status: 'connected', account: { accountId: 'server-one' } });
  expect(authorizationBodies[0]?.get('resource')).toBe(resource);
  expect(authorizationBodies[0]?.get('code_verifier')).toBeTruthy();

  const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established, reloadController: controller,
    resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(featuresSnapshot), allowNativeAccountCredentials: false,
    qualifiedApi: { listAccountsForServices: (services, signal) => listQualifiedConnectedAccountsV4({ token, services, signal }),
      listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token, service, signal }),
      listGroups: (service, signal) => listQualifiedConnectedAccountGroupsV4({ token, service, signal }),
      readGroup: (group, signal) => readQualifiedConnectedAccountGroupV4({ token, group, signal }) } });
  let active = true;
  const subjects = createConnectedAccountRequestAuthSubjectRegistry();
  const callbacks = createDaemonQualifiedRequestAuthCallbacks({ recordScopeChallenge: established.recordScopeChallenge,
    assertSessionAccountCurrent: async () => { if (!active) throw new Error('Session retired'); } });
  const requestAuth = createConnectedAccountRequestAuthService({ ...callbacks,
    refreshExpiredReplacement: async ({ subject, resolved, signal }) => refreshExpiredConnectedAccountRequestAuthReplacement({
      resolved, signal, refreshCoordinator,
      readAccounts: async (service, signal) => (await listQualifiedConnectedAccountsV4({ token, service, signal })).accounts,
      assertCurrent: () => { if (!subject.isCurrent()) throw new Error('Session retired'); },
    }),
    refreshAfterAuthFailure: async ({ resolved, failure, signal }) => {
      const recovery = await applyConnectedAccountRequestAuthRecovery({ resolved, failure, signal,
        refreshCredential: input => refreshCoordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth(input),
        switchAfterClassifiedFailure: async () => { throw new Error('Account-bound MCP authentication must not switch a group'); },
        recordTemporaryRetry: async () => { throw new Error('Authentication refresh must not create quota backoff'); } });
      return { status: recovery.effect === 'stale_context' ? 'stale_context' : 'current_unchanged' };
    }, reportQuotaFailure: async () => { throw new Error('OAuth fixture must not report quota failure'); } });
  const broker = createDaemonControlApp({ getChildren: () => [], machineId: machine.id, controlToken: 'fixture-control',
    stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'unused' }),
    requestShutdown() {}, onHappySessionWebhook() {}, connectedAccountRequestAuth: { authenticate: subjects.authenticate, ...requestAuth } });
  cleanup.push(() => broker.close());
  await broker.listen({ host: '127.0.0.1', port: 0 });
  const brokerAddress = broker.server.address();
  if (!brokerAddress || typeof brokerAddress === 'string') throw new Error('Broker listener unavailable');
  const issuance = { parentSessionId: 'fixture-session', materializationBaseDir: join(harness.baseDir, 'materials'),
    readAccountSettingsSnapshot: () => ({ source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [], mcpServerCatalog: catalog }),
    establishedOwner: established, activatePurposeBindings: purposes.activatePurposeBindings, registry: subjects,
    httpPort: brokerAddress.port, isCurrent: () => active, assertCurrent: async () => { if (!active) throw new Error('Session retired'); } };
  testIssuer = createDaemonMcpRequestAuthForTest({ credentials, materializationBaseDir: issuance.materializationBaseDir,
    establishedOwner: established, activatePurposeBindings: purposes.activatePurposeBindings,
    registry: subjects, getHttpPort: () => brokerAddress.port, isCurrent: () => active });
  if (options?.testPipeline) {
    if (!store) throw new Error('MCP catalog store unavailable');
    beginActiveMcpServerCatalogRefresh({ scopeKey: resolveAccountSettingsScopeKey(credentials),
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
    expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog?.status).toBe('loading');
    // Withdraw catalog readiness before demand. The real issuer must join the
    // encrypted row owner before using the HTTP request-auth broker.
    const admitted = await testIssuer({ serverId: 'server-one', resource, materializationId: 'cold-daemon-admission' }, null);
    try {
      const client = await createConnectedAccountRequestAuthClient({ capabilityFile: admitted.capabilityFile });
      expect(await client.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE }))
        .toMatchObject({ accessToken: 'access-1' });
    } finally { await admitted.cleanup(); }
    await expect(stat(admitted.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const testInput = { t: 'byId', machineId: machine.id, serverId: 'server-one', directory: harness.baseDir };
    expect(DaemonMcpServersTestResponseSchema.parse(await call(RPC_METHODS.DAEMON_MCP_SERVERS_TEST, testInput, false)))
      .toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    testAuthBound = true;
    const tested = DaemonMcpServersTestResponseSchema.parse(await call(RPC_METHODS.DAEMON_MCP_SERVERS_TEST, testInput, false));
    expect(tested.ok, tested.ok ? undefined : JSON.stringify({ error: tested.error,
      stderrTail: tested.stderrTail, upstreamRequests })).toBe(true);
    expect(tested).toMatchObject({ ok: true, toolCount: 2, serverInfo: { name: 'composed-oauth', version: '7.8.9' },
      instructions: 'Instructions from the authenticated upstream.' });
    const persisted = await refreshActiveMcpServerCatalog({ credentials });
    if (persisted.status !== 'ready') throw new Error('Persisted MCP snapshot unavailable');
    const snapshot = McpServerToolsSnapshotV1Schema.parse(persisted.catalog.servers[0]?.toolsSnapshot);
    expect(snapshot).toMatchObject({ machineId: machine.id, serverInfo: { name: 'composed-oauth', version: '7.8.9' },
      instructions: 'Instructions from the authenticated upstream.' });
    expect(snapshot.tools.map(tool => tool.name)).toEqual(['ping', 'second_page_tool']);
    expect(snapshot.tools.every(tool => tool.tokens > 0)).toBe(true);
    expect(testCapabilityPaths).toHaveLength(1);
    for (const path of testCapabilityPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog?.status).toBe('ready');
    failToolsDiscovery = true;
    const failedProbe = DaemonMcpServersTestResponseSchema.parse(await call(RPC_METHODS.DAEMON_MCP_SERVERS_TEST, testInput, false));
    expect(failedProbe).toMatchObject({ ok: false, errorCode: 'mcp_list_tools_failed' });
    failToolsDiscovery = false;
    expect(testCapabilityPaths).toHaveLength(2);
    for (const path of testCapabilityPaths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const afterFailure = await refreshActiveMcpServerCatalog({ credentials });
    expect(afterFailure.status).toBe('ready');
    if (afterFailure.status !== 'ready') throw new Error('MCP catalog unavailable after failed probe');
    expect(afterFailure.revision).toBe(persisted.revision);
    expect(afterFailure.catalog.servers[0]?.toolsSnapshot).toEqual(snapshot);
    const beforeWrongResource = bearerRequests.length;
    const storedEntry = persisted.catalog.servers[0]!;
    expect(await store.mutate({ kind: 'server-update', entry: { ...storedEntry,
      remote: { ...storedEntry.remote!, url: `${resource}/other` } } }, persisted.revision))
      .toMatchObject({ status: 'updated' });
    expect(DaemonMcpServersTestResponseSchema.parse(await call(RPC_METHODS.DAEMON_MCP_SERVERS_TEST, testInput, false)))
      .toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(bearerRequests).toHaveLength(beforeWrongResource);
    const changed = await refreshActiveMcpServerCatalog({ credentials });
    if (changed.status !== 'ready') throw new Error('Changed MCP catalog unavailable');
    expect(await store.mutate({ kind: 'server-update', entry: storedEntry }, changed.revision))
      .toMatchObject({ status: 'updated' });
  }
  const capability = await issueMcpRequestAuthCapability({ serverId: 'server-one', resource, materializationId: 'composed-bridge' }, issuance, new AbortController().signal);
  cleanup.push(() => subjects.retireSessionCapabilities({ parentSessionId: issuance.parentSessionId, materializationId: 'composed-bridge' }));
  const requestClient = await createConnectedAccountRequestAuthClient({ capabilityFile: capability.capabilityFile });
  expect(await requestClient.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE })).toMatchObject({ accessToken: 'access-1' });
  await expect(issueMcpRequestAuthCapability({ serverId: 'server-one', resource: `${resource}/other`, materializationId: 'wrong-resource' }, issuance,
    new AbortController().signal)).rejects.toThrow('mcp_resource_mismatch');
  const runnerCapabilities = new Map<string, string>();
  cleanup.push(async () => {
    for (const materializationId of runnerCapabilities.keys()) {
      await subjects.retireSessionCapabilities({ parentSessionId: issuance.parentSessionId, materializationId });
    }
  });
  const runnerSnapshot = { ...issuance.readAccountSettingsSnapshot(), scopeKey: resolveAccountSettingsScopeKey(credentials) };
  const materialized = await resolveRunnerMcpServers({
    session: { sessionId: issuance.parentSessionId, getServerBinding: () => ({ serverId: 'oauth-fixture-home', serverUrl: homeUrl }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: issuance.parentSessionId, encryptionMode: 'plain' }), updateMetadata() {},
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      getMcpRequestAuthPort: () => ({
        open: async input => {
          const issued = await issueMcpRequestAuthCapability(input, issuance, new AbortController().signal);
          runnerCapabilities.set(input.materializationId, issued.capabilityFile);
          return issued;
        },
        close: input => subjects.retireSessionCapabilities({ parentSessionId: issuance.parentSessionId, ...input }),
      }),
    },
    credentials, accountCredentials: credentials, accountSettings: runnerSnapshot.settings, accountSettingsSnapshot: runnerSnapshot,
    machineId: machine.id, directory: harness.baseDir, tmpDir: harness.baseDir, includeHappierMcpServer: false,
    sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['server-one'], forceExcludeServerIds: [] } },
  });
  cleanup.push(async () => materialized.happierMcpServer.stop());
  expect(runnerCapabilities.size).toBe(1);
  const client = new Client({ name: 'composed-socket-consumer', version: '1.0.0' });
  cleanup.push(() => client.close());
  const bridge = materialized.mcpServers.fixture;
  if (!bridge) throw new Error('Materialized MCP bridge unavailable');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  await client.connect(new StdioClientTransport({ command: bridge.command, args: bridge.args, env: { ...env, ...bridge.env,
    NODE_EXTRA_CA_CERTS: tls.caCertificatePath, NODE_OPTIONS: '--conditions=happier-source' } }));
  expect(CallToolResultSchema.parse(await client.callTool({ name: 'ping', arguments: {} })).content).toEqual([{ type: 'text', text: 'pong' }]);
  const beforeRefresh = await readQualifiedConnectedAccountCredentialV4({ token, ref: {
    service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'server-one',
  } });
  if (!beforeRefresh || beforeRefresh.revisionSemantics !== 'revisioned') throw new Error('Persisted OAuth credential unavailable');
  expect(await refreshCoordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth({ account: beforeRefresh.ref,
    expectedCredentialRevision: beforeRefresh.credentialRevision })).toBe(true);
  const unchallengedRequestStart = bearerRequests.length;
  expect(CallToolResultSchema.parse(await client.callTool({ name: 'ping', arguments: {} })).content).toEqual([{ type: 'text', text: 'pong' }]);
  expect(bearerRequests.slice(unchallengedRequestStart)).toContain('Bearer access-2');
  expect(bearerRequests.slice(unchallengedRequestStart)).not.toContain('Bearer access-1');
  expect(authorizationBodies).toHaveLength(2);
  failNextRequest = true;
  expect(CallToolResultSchema.parse(await client.callTool({ name: 'ping', arguments: {} })).content).toEqual([{ type: 'text', text: 'pong' }]);
  expect(authorizationBodies[2]?.get('grant_type')).toBe('refresh_token');
  expect(authorizationBodies[2]?.get('resource')).toBe(resource);
  const rotatedRequestStart = bearerRequests.length;
  expect(CallToolResultSchema.parse(await client.callTool({ name: 'ping', arguments: {} })).content).toEqual([{ type: 'text', text: 'pong' }]);
  expect(bearerRequests.slice(rotatedRequestStart)).toContain('Bearer access-3');
  expect(bearerRequests.slice(rotatedRequestStart)).not.toContain('Bearer access-2');
  for (const replacementState of ['fresh', 'expired'] as const) {
    const rejectedLease = await requestClient.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE });
    const tokenRequestsBefore = authorizationBodies.length;
    const releaseFailures: Array<() => void> = [];
    const requestsDelayed = new Promise<void>(ready => { delayedAuthenticationFailures = { releases: releaseFailures, ready }; });
    const lateCalls = Promise.all(Array.from({ length: 2 }, () => client.callTool({ name: 'ping', arguments: {} })));
    await Promise.race([requestsDelayed, lateCalls.then(() => { throw new Error('Parallel tool calls finished before reaching the delayed upstream'); })]);
    const current = await readQualifiedConnectedAccountCredentialV4({ token, ref: beforeRefresh.ref });
    if (!current || current.revisionSemantics !== 'revisioned') throw new Error('Persisted OAuth credential unavailable');
    nextTokenExpiresIn = replacementState === 'expired' ? 0 : 3600;
    expect(await refreshCoordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth({ account: current.ref,
      expectedCredentialRevision: current.credentialRevision })).toBe(true);
    nextTokenExpiresIn = 3600;
    const replacementLease = await requestClient.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE });
    expect(replacementLease.credentialContext.credentialRevision).not.toBe(rejectedLease.credentialContext.credentialRevision);
    delayedAuthenticationFailures = null;
    expect(releaseFailures).toHaveLength(2);
    for (const release of releaseFailures) release();
    for (const result of await lateCalls) {
      expect(CallToolResultSchema.parse(result).content, `parallel late 401 with ${replacementState} replacement`)
        .toEqual([{ type: 'text', text: 'pong' }]);
    }
    expect(authorizationBodies).toHaveLength(tokenRequestsBefore + (replacementState === 'expired' ? 2 : 1));
    expect(CallToolResultSchema.parse(await client.callTool({ name: 'ping', arguments: {} })).content)
      .toEqual([{ type: 'text', text: 'pong' }]);
    const accounts = await listQualifiedConnectedAccountsV4({ token, service: beforeRefresh.ref.service });
    const account = accounts.accounts.find(account => account.ref.accountId === beforeRefresh.ref.accountId);
    expect(account).toBeDefined();
    expect(account?.status).not.toBe('needs_reauth');
  }
  active = false;
  await subjects.retireSessionCapabilities({ parentSessionId: issuance.parentSessionId, materializationId: 'composed-bridge' });
  await expect(stat(capability.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const [materializationId, capabilityFile] of runnerCapabilities) {
    await subjects.retireSessionCapabilities({ parentSessionId: issuance.parentSessionId, materializationId });
    await expect(stat(capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  const retiredRequestStart = bearerRequests.length;
  const retired = CallToolResultSchema.parse(await client.callTool({ name: 'ping', arguments: {} }));
  expect(retired.isError).toBe(true);
  expect(bearerRequests).toHaveLength(retiredRequestStart);
  if (options?.testPipeline) {
    active = true;
    const reconnect = await execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: 'server-one' },
      context: { surface: 'cli', actionCaller: { kind: 'host' }, externalActionTarget: { kind: 'machine', machineId: machine.id } } });
    expect(reconnect).toMatchObject({ ok: true });
    if (!reconnect.ok) throw new Error('Reconnect start failed');
    const reconnectAttempt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.signIn.start'].parse(reconnect.result);
    expect(new URL(reconnectAttempt.authorizationUrl).searchParams.get('state')?.startsWith(`${reconnectAttempt.attemptId}.`)).toBe(true);
    expect(await connectedHost.authenticationCommand!(machine.id, { operation: 'cancel', attemptId: reconnectAttempt.attemptId }))
      .toMatchObject({ status: 'cancelled' });
    expect(await connectedHost.controlCommand!(machine.id, { operation: 'revokeAccount',
      account: { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'server-one' }, cleanupGroupReferences: true }))
      .toMatchObject({ status: 'revoked' });
    const beforeRevokedTest = bearerRequests.length;
    expect(DaemonMcpServersTestResponseSchema.parse(await call(RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
      { t: 'byId', machineId: machine.id, serverId: 'server-one', directory: harness.baseDir }, false)))
      .toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(bearerRequests).toHaveLength(beforeRevokedTest);
  }
}

export async function exerciseMcpOAuthMachineTest(): Promise<void> {
  await exerciseMcpOAuthSocketRequestAuth({ testPipeline: true });
}
