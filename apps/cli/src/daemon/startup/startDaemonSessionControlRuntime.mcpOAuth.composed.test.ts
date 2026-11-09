import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:https';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema, accountSettingsParse } from '@happier-dev/protocol';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { McpServerCatalogV1Schema, sealMcpServerCatalogContentV1, MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { McpRequestAuthResultV1Schema, type McpRequestAuthPort, MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import { createDaemonMcpRequestAuthForTest } from '@/daemon/connectedServices/requestAuth/createDaemonMcpRequestAuthForTest';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createQualifiedConnectedAccountDaemonPersistence, createAccountSettingsConnectedAccountSecrets } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { createMcpSignInConnectedAccountRegistration } from '@/mcp/oauth/mcpSignInRuntime';
import { logger } from '@/ui/logger';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { activateRequesterPendingSession } from '@/daemon/sessions/pendingSessionActivationRecovery';
import { releaseUnretainedRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createEphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Use the production control app and broker on an ephemeral OS listener. Home
// responses and native tool IO are the only substituted system boundaries.
vi.mock('@/daemon/controlServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    const app = actual.createDaemonControlApp(input);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing private listener');
    return { port: address.port, stop: () => app.close() };
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); boundary.control = null; });

it.each(['plain', 'e2ee'] as const)('issues a capability from a cold %s daemon Account and requires sign-in only for an absent grant', async mode => {
  const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
    contributes: createResolvedContributionRegistry({}), pluginIds: [],
  } });
  onTestFinished(() => runtime.dispose());
  onTestFinished(resetActiveAccountSettingsSnapshotForTests);
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: `daemon-mcp-${mode}` })).toString('base64url')}.signature`, encryption: mode === 'e2ee'
    ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(19) } : null };
  const settings = { experiments: false, featureToggles: { 'execution.runs': true } };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(settings), rawSettings: settings,
    settingsVersion: 5531, loadedAtMs: 1, settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
    scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const resource = 'https://oauth.example.test/mcp';
  const ref = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'oauth-server' };
  if (!runtime.registry.connectedAccountContributions?.describe(ref.service)) {
    runtime.registry.connectedAccountContributions?.registerHostConnectedAccountRuntime(createMcpSignInConnectedAccountRegistration());
  }
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: ref.accountId, name: 'oauth_fixture',
    transport: 'http', remote: { url: resource, headers: {}, auth: { kind: 'oauth' } },
    env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] });
  const material = credentials.encryption;
  const contentKeyFingerprint = material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null;
  const reads: string[] = [];
  let grant: 'present' | 'absent' | 'invalid' | 'unreachable' = 'present';
  const envelope = (kind: 'credential' | 'configuration', payload: unknown) => {
    if (mode === 'plain') return sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', payload,
      randomBytes: length => new Uint8Array(length).fill(7) });
    if (!material) throw new Error('E2EE fixture material is missing');
    return sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'e2ee', material, payload,
      randomBytes: length => new Uint8Array(length).fill(7) });
  };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode, version: 1, settingsVersion: 5531, signingKeyFingerprint: null,
      contentKeyFingerprint, updatedAt: 1,
      ...(mode === 'e2ee' ? { recipientEnvelopeReadiness: { status: 'available' } } : {}),
    } };
    if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 3,
      content: sealMcpServerCatalogContentV1({ mode, material, catalog }) } };
    if (path === '/v4/connect/qualified/credential') {
      if (grant === 'absent') return { status: 404, data: {} };
      if (grant === 'unreachable') return { status: 503, data: {} };
      if (grant === 'invalid') return { status: 200, data: { private: 'invalid-credential-payload' } };
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref,
        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationRevision: 'config-1', metadata: { scopes: ['read'] },
        content: envelope('credential', { v: 1, values: { accessToken: 'fixture-bearer' } }) }) };
    }
    if (path === '/v4/connect/qualified/configuration') return { status: 200,
      data: QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ target: { kind: 'account', ref },
        authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationRevision: 'config-1', configurationContent: envelope('configuration', {
          values: { serverId: ref.accountId, resource }, secretRefs: {}, secretValues: {},
        }) }) };
    throw new Error(`Unexpected cold daemon Account boundary: ${path}`);
  });
  const readMode = async (signal?: AbortSignal) => (await fetchAccountEncryptionCurrentness({ token: credentials.token, signal })).mode;
  const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials,
    getAccountEncryptionMode: () => readMode(),
    secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) }) });
  const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials, reloadController: runtime.controller,
    getAccountEncryptionMode: readMode, configuration: persistence.configuration });
  const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
    reloadController: runtime.controller, resolveQualifiedConnectedAccountV4Support: () => 'advertised', allowNativeAccountCredentials: false });
  const issue = createDaemonMcpRequestAuthForTest({ credentials, materializationBaseDir: runtime.happyHomeDir,
    establishedOwner: established, activatePurposeBindings: purposes.activatePurposeBindings,
    registry: createConnectedAccountRequestAuthSubjectRegistry(), getHttpPort: () => 1,
    isCurrent: () => runtime.controller.isRuntimeRegistryCurrent(runtime.registry) });
  const diagnostics = vi.spyOn(logger, 'infoFile');
  for (let open = 0; open < 2; open++) {
    const capability = await issue({ serverId: ref.accountId, resource, materializationId: `cold-daemon-${open}` }, null);
    try {
      McpRequestAuthResultV1Schema.parse({ kind: 'mcp.request_auth', capabilityFile: capability.capabilityFile, resource: capability.resource });
      expect((await stat(capability.capabilityFile)).isFile()).toBe(true);
      expect(diagnostics.mock.calls).toEqual(expect.arrayContaining([
        ['[mcp] Request-auth issuance phase', expect.objectContaining({ phase: 'initial_admission', status: 'completed' })],
        ['[mcp] Request-auth issuance phase', expect.objectContaining({ phase: 'authority_commit', status: 'completed' })],
      ]));
    } finally { await capability.cleanup(); }
    await expect(stat(capability.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 3 });
  expect(reads.filter(path => path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1)).toHaveLength(1);
  for (const state of ['absent', 'invalid', 'unreachable'] as const) {
    grant = state;
    await expect(issue({ serverId: ref.accountId, resource, materializationId: `refused-${state}` }, null))
      .rejects.toThrow(state === 'absent' ? /^mcp_sign_in_required$/ : /^mcp_request_auth_unavailable$/);
    expect((await readdir(runtime.happyHomeDir)).filter(name => name.startsWith('mcp-'))).toEqual([]);
  }
  grant = 'present';
  const recovered = await issue({ serverId: ref.accountId, resource, materializationId: 'recovered' }, null);
  await recovered.cleanup();
});

it('logs the requester admission refusal before issuance without disclosing Home exception text', async () => {
  vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
  const diagnostics = vi.spyOn(logger, 'infoFile');
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  const post = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (url, ...args) => {
    if (String(url).endsWith('/admission/verify')) throw new Error('private-requester-http-body');
    return post(url, ...args);
  });
  diagnostics.mockClear();
  const result = await h.dispatch({ kind: 'mcp.request_auth.open', requestId: 'requester-refused',
    serverId: 'own-server', resource: 'https://private-resource.example.test/mcp', materializationId: 'requester-refused' });
  expect(result).toMatchObject({ ok: false, error: { code: 'mcp_request_auth_unavailable' } });
  const phases = diagnostics.mock.calls.filter(([message]) => message === '[mcp] Request-auth dispatch phase');
  expect(phases).toEqual([['[mcp] Request-auth dispatch phase', expect.objectContaining({
    phase: 'requester_admission', status: 'failed', checkpoint: 'requester_resolution',
    failureCode: 'requester_session_not_current', sessionId: h.sessionId,
    durationMs: expect.any(Number),
  })]]);
  expect(JSON.stringify(phases)).not.toContain('private-requester-http-body');
  expect(JSON.stringify(phases)).not.toContain('private-resource');
  expect(JSON.stringify(phases)).not.toContain(h.requester.bootstrap.credentials.token);
  expect(phases[0]?.[1]).not.toHaveProperty('requestId');
  expect(diagnostics.mock.calls.some(([message]) => message === '[mcp] Request-auth issuance phase')).toBe(false);
});

it('correlates parallel MCP opens through requester and signed Machine Home verification without leaking credentials', async () => {
  vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  const diagnostics = vi.spyOn(logger, 'warnLocalFile');
  const phaseDiagnostics = vi.spyOn(logger, 'infoFile');
  const requestIds = ['4f67d9d2-e6dc-48ab-a1f1-4545d72cab01', '4f67d9d2-e6dc-48ab-a1f1-4545d72cab02'];
  await Promise.all(requestIds.map(requestId => h.dispatch({
    kind: 'mcp.request_auth.open', requestId, serverId: 'absent-oauth',
    resource: 'https://private-resource.example.test/mcp', materializationId: requestId,
  })));
  const records = diagnostics.mock.calls.filter(([message]) => message === '[web-latency]')
    .map(([, fields]) => fields);
  for (const requestId of requestIds) {
    expect(phaseDiagnostics.mock.calls).toEqual(expect.arrayContaining([
      ['[mcp] Request-auth dispatch phase', expect.objectContaining({ requestId, sessionId: h.sessionId })],
      ['[mcp] Request-auth issuance phase', expect.objectContaining({ requestId, sessionId: h.sessionId, phase: 'initial_admission' })],
    ]));
    const owned = records.filter(fields => fields && typeof fields === 'object' && 'requestId' in fields && fields.requestId === requestId);
    for (const phase of ['mcp.requester_resolution', 'mcp.requester_currentness']) {
      expect(owned).toEqual(expect.arrayContaining([expect.objectContaining({ requestId, phase, status: 'completed' })]));
    }
    // The incumbent bootstrap may share an outstanding proof across opens.
    // Follow that diagnostic link instead of demanding another Home admission.
    const reused = owned.find(fields => fields && typeof fields === 'object' && 'phase' in fields
      && fields.phase === 'requester.currentness_reuse' && 'sourceRequestId' in fields && fields.sourceRequestId !== requestId);
    const sourceRequestId = reused && typeof reused === 'object' && 'sourceRequestId' in reused ? reused.sourceRequestId : requestId;
    const observed = records.filter(fields => fields && typeof fields === 'object' && 'requestId' in fields && fields.requestId === sourceRequestId);
    if (reused) {
      expect(reused).toEqual(expect.objectContaining({ sourceSpanId: expect.any(Number) }));
      const sourceSpanId = reused && typeof reused === 'object' && 'sourceSpanId' in reused ? reused.sourceSpanId : undefined;
      expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ spanId: sourceSpanId, phase: 'mcp.requester_resolution' })]));
    }
    for (const phase of ['requester.credential_binding',
      'requester.machine_before', 'requester.machine_after', 'requester.machine_verification',
      'requester.machine_profile', 'requester.machine_access', 'requester.machine_signed_verification']) {
      expect(observed, `${requestId}: ${phase}`).toEqual(expect.arrayContaining([expect.objectContaining({
        requestId: sourceRequestId, sessionId: h.sessionId, phase, status: 'completed', elapsedMs: expect.any(Number),
        spanId: expect.any(Number),
      })]));
    }
    const signed = observed.filter(fields => fields && typeof fields === 'object' && 'phase' in fields && fields.phase === 'requester.machine_signed_verification');
    for (const fields of signed) {
      expect(fields).toEqual(expect.objectContaining({ parentSpanId: expect.any(Number) }));
      const parentSpanId = fields && typeof fields === 'object' && 'parentSpanId' in fields ? fields.parentSpanId : undefined;
      expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ spanId: parentSpanId, phase: 'requester.machine_verification' })]));
    }
  }
  expect(records).not.toHaveLength(0);
  expect(records.every(fields => fields && typeof fields === 'object' && 'requestId' in fields
    && requestIds.includes(String(fields.requestId)))).toBe(true);
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(h.requester.bootstrap.credentials.token);
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-resource');
});

it('shares one opening requester observation through warm MCP catalog admission and reobserves on the next open', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control);
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let sessionReads = 0;
  vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
    if (new URL(String(url)).pathname === `/v2/sessions/${h.sessionId}`) sessionReads++;
    return get(url, ...args);
  });
  const admissions: number[] = [];
  vi.spyOn(logger, 'infoFile').mockImplementation((message, fields) => {
    if (message === '[mcp] Request-auth dispatch phase' && fields && typeof fields === 'object'
      && 'status' in fields && fields.status === 'completed') {
      admissions.push(sessionReads);
    }
  });
  for (let open = 0; open < 2; open++) {
    sessionReads = 0;
    expect(await h.dispatch({ kind: 'mcp.request_auth.open', requestId: `warm-admission-${open}`,
      serverId: 'absent-oauth', resource: 'https://oauth.example.test/mcp', materializationId: `warm-admission-${open}` }))
      .toMatchObject({ ok: false, error: { code: 'mcp_catalog_unavailable' } });
    // An unavailable catalog refuses before grant/effect admission. Dispatch
    // and the issuer's catalog preparation prove the same opening requester;
    // the next open must obtain a new Home observation.
    expect(admissions).toHaveLength(open + 1);
    expect(admissions[open]).toBe(1);
    expect(sessionReads).toBe(1);
  }
});

it('admits an OAuth server from the Session requester catalog and supplies request auth on consecutive calls', async () => {
  vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
  const diagnostics = vi.spyOn(logger, 'infoFile');
  const traceDiagnostics = vi.spyOn(logger, 'warnLocalFile');
  const nativeFetch = globalThis.fetch;
  const features = await fetchServerFeaturesSnapshot({ serverUrl: 'https://session-home.test', token: 'requester-token',
    fetchImpl: async () => Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } })) });
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, false, undefined, pluginReloadController,
    { resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(features) });
  // Native lazy recovery is already present. The recovered requester still has
  // no MCP catalog until the request-auth issuance owner demands it.
  await h.replaceRequesterRuntime();
  delete h.tracked.requesterSessionRuntimeContext;
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'session-home.test' && url.pathname === '/v1/features') {
      return Promise.resolve(Response.json(FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_requester_home' } } })));
    }
    return url.hostname === '127.0.0.1' ? nativeFetch(input, init) : homeFetch(input, init);
  }) satisfies typeof fetch);
  const tls = await createEphemeralTlsServerFixture();
  onTestFinished(() => tls.cleanup());
  let toolCalls = 0;
  const upstream = createServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) }, async (request, response) => {
    if (request.headers.authorization !== 'Bearer fixture-bearer') { response.writeHead(401).end(); return; }
    const server = new Server({ name: 'oauth-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      toolCalls++;
      return { content: [{ type: 'text', text: 'OAUTH_SESSION_TOOL_OK' }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing upstream listener');
  const resource = `https://127.0.0.1:${address.port}/mcp`;
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'oauth-server', name: 'oauth_fixture',
    transport: 'http', remote: { url: resource, headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }],
    bindings: [{ id: 'everywhere', serverId: 'oauth-server', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] });
  const ref = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'oauth-server' };
  const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const envelope = (kind: 'credential' | 'configuration', payload: unknown) => sealQualifiedConnectedAccountContentEnvelope({
    kind, accountMode: 'plain', payload, randomBytes: length => new Uint8Array(length) });
  let catalogReadable = true;
  let grantAvailable = true;
  let grantTransportFails = false;
  let credentialSnapshotUnavailable = false;
  let missingCredentialReads = 0;
  let nextRequesterProfileDelayMs = 0;
  let revokeRequesterWhenStaged = false;
  const accountHeaders: unknown[] = [];
  const pendingTarget = { homeId: 'srv_requester_home', accountId: h.f.bootstrap.attribution.accountId,
    machineId: 'machine', installationId: h.f.installation.installationId, sessionId: h.sessionId };
  const runtimeDescriptor = { v: 1, agentId: 'codex', agent: {
    backendMode: 'appServer', providerSessionId: 'native-requester-thread',
  } };
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1 || path.startsWith('/v4/connect/qualified/')
      || path.startsWith(`/v2/sessions/${h.sessionId}`)) {
      accountHeaders.push(options?.headers?.Authorization);
    }
    if (path === `/v2/sessions/${h.sessionId}/pending`) return { status: 200, data: { pending: [{
      localId: 'wake-input', messageRole: 'user', status: 'queued', deliveryState: null,
      requestedAction: { v: 1, kind: 'send_now' },
    }] } };
    if (path === `/v2/sessions/${h.sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
      id: h.sessionId, encryptionMode: 'plain', dataEncryptionKey: null, share: null,
      metadata: JSON.stringify({ machineId: 'machine', path: h.cwd, flavor: 'codex',
        codexSessionId: 'native-requester-thread', runtimeDescriptorV1: runtimeDescriptor }),
      pendingCount: 1, pendingVersion: 1, pendingActivationAuthorization: { status: 'waiting',
        requestId: 'wake-input', requestedAt: 12, admittedTarget: pendingTarget },
    }) } };
    if (path === '/v1/account/profile') {
      // Home latency is the system boundary. The native bridge below must
      // tolerate a valid proof beyond the former subordinate cutoff.
      const delayMs = nextRequesterProfileDelayMs || 2;
      nextRequesterProfileDelayMs = 0;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) {
      return { status: catalogReadable ? 200 : 403, data: catalogReadable ? { status: 'present', revision: 1,
        content: sealMcpServerCatalogContentV1({ mode: 'plain', material: null, catalog }) } : { error: 'forbidden' } };
    }
    if (path === '/v4/connect/qualified/accounts') return { status: 200, data: QualifiedConnectedAccountListResponseV4Schema.parse({
      service: ref.service, accounts: grantAvailable ? [{ ref, status: 'connected', authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned', credentialRevision, configurationReady: true, configurationRevision: 'config-1', scopes: ['read'] }] : [] }) };
    if (path === '/v4/connect/qualified/credential') {
      if (grantTransportFails) throw new Error(`private-auth-failure fixture-bearer ${resource}\n    at /private/private_failure_marker.js:1:1`);
      if (credentialSnapshotUnavailable) { missingCredentialReads++; return { status: 404, data: {} }; }
      // Revoke at the Home boundary after the actual registry has staged a
      // capability, while its final grant proof is still in flight.
      if (revokeRequesterWhenStaged && (await readdir(requester.connectedServicesMaterializationBaseDir)).some(name => name.startsWith('mcp-'))) {
        revokeRequesterWhenStaged = false;
        h.f.retire();
      }
      return grantAvailable ? { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref, authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision, configurationRevision: 'config-1',
      content: envelope('credential', { v: 1, values: { accessToken: 'fixture-bearer' } }), metadata: { scopes: ['read'] } }) }
      : { status: 404, data: {} };
    }
    if (path === '/v4/connect/qualified/configuration') return { status: 200, data: QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
      target: { kind: 'account', ref }, authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision,
      configurationRevision: 'config-1', configurationContent: envelope('configuration', { values: { serverId: ref.accountId, resource }, secretRefs: {}, secretValues: {} }) }) };
    return get(url, options);
  });
  const capabilityPaths: string[] = [];
  const openRequestIds: string[] = [];
  let issuanceFailure: string | undefined;
  const port: McpRequestAuthPort = {
    open: async input => {
      const requestId = randomUUID();
      openRequestIds.push(requestId);
      const result = await h.dispatch({ kind: 'mcp.request_auth.open', requestId, ...input });
      if (!result.ok) { issuanceFailure = result.error.code; throw new Error(result.error.code); }
      const capability = McpRequestAuthResultV1Schema.parse(result.result);
      capabilityPaths.push(capability.capabilityFile);
      return { capabilityFile: capability.capabilityFile, resource: capability.resource };
    },
    close: async input => {
      expect(await h.dispatch({ kind: 'mcp.request_auth.close', requestId: 'close-oauth', ...input }))
        .toMatchObject({ ok: true, result: { kind: 'mcp.request_auth.closed' } });
    },
  };
  const requester = (await h.replaceRequesterRuntime());
  expect(requester.readAccountSettingsSnapshot().mcpServerCatalog).toBeUndefined();
  const runnerOperation = runWithServerHttpBaseUrl('https://session-home.test', () => createInvocationSavedSecretOperationContextV1({
    credentials: requester.bootstrap.credentials, snapshot: requester.readAccountSettingsSnapshot(),
    serverHttpBaseUrl: 'https://session-home.test', isCurrent: requester.isCurrent,
  }));
  expect(await createCliMcpServerStoreForOperation({ operationContext: runnerOperation }).readCatalogForOperation())
    .toMatchObject({ status: 'ready' });
  expect(requester.readAccountSettingsSnapshot().mcpServerCatalog).toBeUndefined();
  const runnerSnapshot = runnerOperation.readSnapshot()!;
  // A resumed runner on a freshly booted daemon must not rely on an earlier
  // credential read or retained requester runtime from the initial launch.
  await requester.dispose();
  delete h.tracked.requesterSessionRuntimeContext;
  let wakeSpawned = false;
  await activateRequesterPendingSession({ machineId: 'machine',
    binding: { sessionId: h.sessionId, attribution: h.tracked.requesterWorkAttributionV1! },
    hint: { sessionId: h.sessionId, requestId: 'wake-input', requestedAt: 12, pendingVersion: 1, source: 'live' },
    resolveRequesterSessionRuntimeContext: h.resolveRequesterRuntime,
    releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
      [...h.pidToTrackedSession.values()].map(tracked => tracked.requesterSessionRuntimeContext)),
    resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
      serverUrl: 'https://session-home.test', resolveCurrentMachineId: () => 'machine',
    }),
    // Process launch is the native boundary. The wake, custody recovery,
    // requester construction and subsequent MCP resolution stay real.
    spawnSessionForInternalResume: async options => {
      expect(options).toMatchObject({ existingSessionId: h.sessionId, runtimeDescriptorV1: runtimeDescriptor,
        requesterWorkAttributionV1: h.tracked.requesterWorkAttributionV1,
        executionAuthorization: { provenance: 'user_request', requestId: 'wake-input', requestedAt: 12 } });
      expect(options.requesterSessionRuntimeContext).toBe(h.tracked.requesterSessionRuntimeContext);
      expect(options.requesterSessionBootstrap?.credentials.token).toBe(requester.bootstrap.credentials.token);
      wakeSpawned = true;
      return { type: 'success', sessionId: h.sessionId };
    },
  });
  expect(wakeSpawned).toBe(true);
  vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
  const resolved = await runWithServerHttpBaseUrl('https://session-home.test', () => resolveRunnerMcpServers({
    session: { sessionId: h.sessionId, getServerBinding: () => ({ serverId: 'session-home', serverUrl: 'https://session-home.test' }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }), updateMetadata() {},
      getMcpRequestAuthPort: () => port, enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }) },
    credentials: requester.bootstrap.credentials, accountCredentials: requester.bootstrap.credentials,
    accountSettings: runnerSnapshot.settings, accountSettingsSnapshot: runnerSnapshot,
    machineId: 'machine', directory: h.cwd, tmpDir: h.f.directory, includeHappierMcpServer: false,
    sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['oauth-server'], forceExcludeServerIds: [] } },
  }));
  try {
    expect(issuanceFailure).toBeUndefined();
    expect(h.readRequesterRecoveryStage()).toBe('ready');
    expect(h.tracked.requesterSessionRuntimeContext).not.toBe(requester);
    expect(Object.keys(resolved.mcpServers)).toEqual(['oauth_fixture']);
    const nextCapability = await port.open({ serverId: ref.accountId, resource, materializationId: 'next-preparation' });
    expect(nextCapability.resource).toBe(resource);
    const nextClient = await createConnectedAccountRequestAuthClient({ capabilityFile: nextCapability.capabilityFile });
    expect((await nextClient.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE })).accessToken === 'fixture-bearer').toBe(true);
    const issuancePhases = diagnostics.mock.calls.flatMap(([message, fields]) => message === '[mcp] Request-auth issuance phase' ? [fields] : []);
    expect(issuancePhases).toEqual(expect.arrayContaining(['catalog_admission', 'initial_admission', 'capability_staging', 'authority_commit']
      .map(phase => expect.objectContaining({ phase, status: 'completed', sessionId: h.sessionId }))));
    for (const requestId of openRequestIds) {
      expect(issuancePhases).toEqual(expect.arrayContaining(['catalog_admission', 'initial_admission', 'capability_staging', 'authority_commit']
        .map(phase => expect.objectContaining({ requestId, sessionId: h.sessionId, phase, status: 'completed' }))));
      expect(traceDiagnostics.mock.calls).toEqual(expect.arrayContaining(['mcp.credentials', 'mcp.initial_admission', 'mcp.authority_commit']
        .map(phase => ['[web-latency]', expect.objectContaining({ requestId, sessionId: h.sessionId, phase, status: 'completed' })])));
    }
    expect(JSON.stringify(issuancePhases)).not.toContain(resource);
    expect(JSON.stringify(issuancePhases)).not.toContain(h.f.directory);
    expect(JSON.stringify(issuancePhases)).not.toContain(requester.bootstrap.credentials.token);
    await port.close({ materializationId: 'next-preparation' });
    await expect(stat(nextCapability.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const bridgeConfig = JSON.parse(await readFile(resolved.mcpServers.oauth_fixture!.env!.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE!, 'utf8'));
    expect(bridgeConfig.auth.resource).toBe(resource);
    const client = await createConnectedAccountRequestAuthClient({ capabilityFile: bridgeConfig.auth.capabilityFile });
    const auth = await client.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE });
    expect(auth.accessToken === 'fixture-bearer').toBe(true);
    const toolClient = new Client({ name: 'native-session-consumer', version: '1' });
    onTestFinished(() => toolClient.close());
    const bridge = resolved.mcpServers.oauth_fixture!;
    // Run the current bridge source through the canonical TSX loader while
    // retaining the materializer's real private configuration and capability.
    const sourceBridge = await resolveNodeBackedMcpServerCommand({
      distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
      sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
      preferSourceEntrypoint: true,
    });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    // The loaded native failure returns broker HTTP 503 at its former implicit
    // 20-second cutoff. Hold one real Home observation just beyond that boundary:
    // Session-issued auth must still reach the actual bridge and both tool calls.
    nextRequesterProfileDelayMs = 20_100;
    await toolClient.connect(new StdioClientTransport({ command: sourceBridge.command, args: sourceBridge.args, env: { ...env, ...bridge.env, ...sourceBridge.env,
      NODE_EXTRA_CA_CERTS: tls.caCertificatePath, NODE_OPTIONS: '--conditions=happier-source' } }));
    for (let turn = 0; turn < 2; turn++) {
      expect(CallToolResultSchema.parse(await toolClient.callTool({ name: 'echo', arguments: {} })).content)
        .toEqual([{ type: 'text', text: 'OAUTH_SESSION_TOOL_OK' }]);
      expect(toolCalls).toBe(turn + 1);
    }
    expect(accountHeaders.length).toBeGreaterThan(0);
    expect(accountHeaders.every(header => header === `Bearer ${requester.bootstrap.credentials.token}`)).toBe(true);
    expect(accountHeaders).not.toContain('Bearer custodian-token');
    expect(await h.dispatch({ kind: 'mcp.request_auth.open', requestId: 'wrong-resource', serverId: ref.accountId,
      resource: `${resource}/other`, materializationId: 'wrong-resource' }))
      .toMatchObject({ ok: false, error: { code: 'mcp_resource_mismatch' } });
    grantAvailable = false;
    const revoked = CallToolResultSchema.parse(await toolClient.callTool({ name: 'echo', arguments: {} }));
    expect(revoked.isError).toBe(true);
    expect(toolCalls).toBe(2);
    grantAvailable = true;
    catalogReadable = false;
    const refused = await h.dispatch({ kind: 'mcp.request_auth.open', requestId: 'unreadable', serverId: ref.accountId,
      resource, materializationId: 'unreadable' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'mcp_catalog_unavailable' } });
    // A successful catalog transport can publish an unavailable observation.
    // Diagnose the failing admission step, without exposing the opened content.
    expect(diagnostics.mock.calls).toEqual(expect.arrayContaining([
      ['[mcp] Request-auth issuance phase', expect.objectContaining({
        phase: 'initial_admission', status: 'failed', failureCode: 'mcp_catalog_unavailable',
        failureLocation: expect.stringMatching(/^[A-Za-z0-9._-]+\.(?:[cm]?js|tsx?):\d+:\d+$/),
      })],
    ]));
    catalogReadable = true;
    grantTransportFails = true;
    const failedCredentialRequestId = randomUUID();
    expect(await h.dispatch({ kind: 'mcp.request_auth.open', requestId: failedCredentialRequestId, serverId: ref.accountId,
      resource, materializationId: 'transport-unavailable' }))
      .toMatchObject({ ok: false, error: { code: 'mcp_request_auth_unavailable' } });
    expect(traceDiagnostics.mock.calls).toEqual(expect.arrayContaining([
      ['[web-latency]', expect.objectContaining({ requestId: failedCredentialRequestId, sessionId: h.sessionId,
        phase: 'mcp.credentials', status: 'failed' })],
    ]));
    expect(diagnostics.mock.calls).toEqual(expect.arrayContaining([
      ['[mcp] Request-auth issuance phase', expect.objectContaining({
        phase: 'initial_admission', status: 'failed', failureCode: 'mcp_request_auth_unavailable',
        failureLocation: expect.stringMatching(/^[A-Za-z0-9._-]+\.(?:[cm]?js|tsx?):\d+:\d+$/),
      })],
    ]));
    const admissionDiagnostics = diagnostics.mock.calls.filter(([message]) => message === '[mcp] Request-auth issuance phase');
    expect(JSON.stringify(admissionDiagnostics)).not.toContain(resource);
    expect(JSON.stringify(admissionDiagnostics)).not.toContain('fixture-bearer');
    expect(JSON.stringify(admissionDiagnostics)).not.toContain('private-auth-failure');
    expect(JSON.stringify(admissionDiagnostics)).not.toContain('private_failure_marker');
    expect(JSON.stringify(admissionDiagnostics)).not.toContain(requester.bootstrap.credentials.token);
    for (const privateValue of [resource, h.f.directory, 'fixture-bearer', 'private-auth-failure', 'private_failure_marker', requester.bootstrap.credentials.token]) {
      expect(JSON.stringify(traceDiagnostics.mock.calls)).not.toContain(privateValue);
    }
    grantTransportFails = false;
    // A listed account may have no credential snapshot. Exercise the actual
    // recovered requester, Home reader, issuer and runner materializer together:
    // capability refusal is not Session startup refusal under optional policy.
    credentialSnapshotUnavailable = true;
    for (const strictMode of [false, true]) {
      const missingReadsBefore = missingCredentialReads;
      const settings = accountSettingsParse({ ...runnerSnapshot.settings, mcpServersStrictMode: strictMode });
      const notices: unknown[] = [];
      let metadata = createTestMetadata();
      const prepare = () => runWithServerHttpBaseUrl('https://session-home.test', () => resolveRunnerMcpServers({
        session: { sessionId: h.sessionId, getServerBinding: () => ({ serverId: 'session-home', serverUrl: 'https://session-home.test' }),
          rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }),
          getMetadataSnapshot: () => metadata, updateMetadata(update) { metadata = update(metadata); },
          getMcpRequestAuthPort: () => port,
          enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; } },
        credentials: requester.bootstrap.credentials, accountCredentials: requester.bootstrap.credentials,
        accountSettings: settings, accountSettingsSnapshot: { ...runnerSnapshot, settings },
        machineId: 'machine', directory: h.cwd, tmpDir: h.f.directory, includeHappierMcpServer: false,
      }));
      if (strictMode) {
        await expect(prepare()).rejects.toThrow(/^mcp_sign_in_required$/);
        expect(notices).toEqual([]);
      } else {
        for (let startup = 0; startup < 2; startup++) {
          const optional = await prepare();
          try { expect(optional.mcpServers).toEqual({}); }
          finally { optional.happierMcpServer.stop(); }
        }
        expect(notices.map(readSessionCapabilityNoticeV1)).toEqual([{
          v: 1, items: [{ kind: 'mcp_server', name: 'oauth_fixture', itemId: 'oauth-server',
            code: 'invalid_server', detail: 'mcp_sign_in_required' }],
        }]);
      }
      expect(missingCredentialReads).toBeGreaterThan(missingReadsBefore);
      expect(issuanceFailure).toBe('mcp_sign_in_required');
    }
    credentialSnapshotUnavailable = false;
  } finally {
    resolved.happierMcpServer.stop();
    await port.close({ materializationId: 'unreadable' });
    // Runner stop retires descriptors asynchronously through the same port.
    for (const path of capabilityPaths) await vi.waitFor(async () => {
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }
  catalogReadable = true;
  grantAvailable = true;
  revokeRequesterWhenStaged = true;
  const refusedAtCommit = await h.dispatch({ kind: 'mcp.request_auth.open', requestId: 'revoked-before-commit',
    serverId: ref.accountId, resource, materializationId: 'revoked-before-commit' });
  expect(revokeRequesterWhenStaged, 'Home revocation must occur during the staged grant proof').toBe(false);
  // A recovered requester can observe retirement in a nested Home proof before
  // the issuer's local lifetime check. Both paths must withhold the capability.
  expect(refusedAtCommit).toMatchObject({ ok: false });
  if (!refusedAtCommit.ok) expect(['mcp_request_auth_not_active', 'mcp_request_auth_unavailable'])
    .toContain(refusedAtCommit.error.code);
  // stop() retires through the async port: absence of the capability file above
  // precedes release of its sibling mutation lock. Join the complete cleanup.
  await vi.waitFor(async () => {
    expect((await readdir(requester.connectedServicesMaterializationBaseDir)).filter(name => name.startsWith('mcp-'))).toEqual([]);
  });
}, 120_000);
