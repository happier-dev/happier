import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  accountSettingsParse,
  FeaturesResponseSchema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createExecutionRunOccurrenceWitnessRegistry } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { SessionActionConfirmationRuntimeBinding } from '@/session/actions/approvals/sessionActionConfirmation';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';
import { createDeferred } from '@/testkit/async/deferred';
import { createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createRestrictedCurrentSessionListActionDependency } from '@/session/actions/sessionListActionDependency';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { readRequesterSessionCredentialsForChild, requesterSessionCredentialPath, REQUESTER_SESSION_ID_ENV } from '@/daemon/sessionEncryption/requesterSessionCustody';
import { connectSessionMcpClient } from './sessionMcpLocalClient';
import { sessionMcpAuthorizationHeaders, sessionMcpTestFetch } from './sessionMcpClient.testkit';
import { createSessionDaemonAuthorityFixture } from './sessionDaemonAuthority.testkit';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

const daemonCatalogBoundary = vi.hoisted(() => ({
  read: vi.fn(async (_input?: Readonly<{ signal?: AbortSignal }>) => ({ kind: 'available' as const, plugins: [] as [], tools: [] as [] })),
}));

async function admittedSource(sessionId: string, options: Parameters<typeof createProjectSessionRuntimeFixture>[0] = {}) {
  const source = await createProjectSessionRuntimeFixture({
    accountId: 'runner-account', serverId: 'run-home', serverUrl: 'https://run-home.test',
    homeServerIdentityId: 'srv_run_home', boundSessionId: sessionId, ...options,
  });
  vi.stubEnv(REQUESTER_SESSION_ID_ENV, sessionId);
  const credentials = await readRequesterSessionCredentialsForChild(requesterSessionCredentialPath({
    happyHomeDir: source.directory, sessionId, attribution: source.bootstrap.attribution,
  }));
  if (!credentials) throw new Error('Expected admitted requester custody');
  return { credentials, home: { serverId: 'run-home', serverUrl: 'https://run-home.test' } };
}

// The daemon catalog is a transport boundary; the MCP server and Action execution stay real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: daemonCatalogBoundary.read,
  // With no contributed metadata Action, the actual daemon reports unmatched
  // and the Session's built-in catalog owner handles this read.
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetActiveAccountSettingsSnapshotForTests();
  daemonCatalogBoundary.read.mockReset().mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
});

describe('Session-owned Run MCP binding', () => {
  it('forwards child Account reads with its own occurrence and host caller witness', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const { credentials, home } = await admittedSource('child-account-session');
    const requests: Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>[] = [];
    const authority = await createSessionDaemonAuthorityFixture({ sessionId: 'child-account-session', execute: async operation => {
      requests.push(operation);
      return operation.actionId === 'reviews.comments.get'
        ? { ok: false, errorCode: 'not_found', error: 'not_found' }
        : { ok: true, result: { sessions: [], nextCursor: null, hasNext: false } };
    } });
    const lifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = { turnId: 'child-turn', inputId: 'child-input',
      userMessageSeq: null, userMessageSeqs: [], callerPermissionMode: 'read-only' };
    const controller = { kind: 'backend', controllerOccurrenceId: 'child-occurrence' } as Extract<ExecutionRunController, { kind: 'backend' }>;
    const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['child-run', controller]]));
    const occurrence = registry.register({ runId: 'child-run', sidechainId: 'child-sidechain', controller,
      runtimeLifetimeSignal: lifetime.signal, readActiveTurnAdmissionWitness: () => witness });
    const { token } = credentials;
    const settings = accountSettingsParse({});
    const binding = await resolveRunnerMcpServers({ session: createMutableApiSessionClientFixture({ sessionId: 'child-account-session',
      overrides: { getServerBinding: () => home, getBackendTarget: () => ({ kind: 'backend', backendId: 'acme-external',
        configuredBackendId: 'acme-external', sourceKind: 'configured' }) } }),
      credentials, accountSettings: settings,
      accountSettingsSnapshot: { source: 'network', settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken(token), mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1,
          diagnostics: [], catalog: { v: 1, servers: [], bindings: [] } } },
      machineId: 'machine', directory: '/child', env: {},
      executionRun: { runId: 'child-run', workDepth: 4, cwd: '/child', signal: lifetime.signal,
        isCurrent: () => true, getPermissionMode: () => 'read-only', readActiveTurnAdmissionWitness: () => witness,
        readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence } });
    if (!binding.sessionMcpContext) throw new Error('Missing Session MCP context');
    const connection = await connectSessionMcpClient(binding.sessionMcpContext);
    const { client } = connection;
    try {
      const result = await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.list', input: {} } });
      expect(result.isError, JSON.stringify(result)).toBe(false);
      const review = await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'reviews.comments.get', input: { commentId: 'missing-comment' } } });
      expect(review.isError).toBe(true);
      expect(JSON.stringify(review)).toContain('not_found');
      expect(requests.map(request => request.actionId))
        .toEqual(['session.list', 'reviews.comments.get']);
      for (const request of requests) expect(request).toMatchObject({
        reviewCommentPrincipal: { actor: { kind: 'agent', sessionId: 'child-account-session', agentId: 'acme-external' } },
        executionRun: { runId: 'child-run', occurrenceId: 'child-occurrence' },
        witness: { turnId: 'child-turn', inputId: 'child-input', workDepth: 4,
          agentStartCaller: { kind: 'session', sessionId: 'child-account-session', starterDepth: 4, turnDepth: 4 } } });
    } finally {
      await connection.close(); await binding.happierMcpServer.stop(); occurrence.dispose();
      await authority.close();
    }
  });
  it('lists only its bound Session through restricted child HTTP MCP Action execution', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', '');
    const sessionId = 'restricted-child-session';
    const home = { serverId: 'restricted-child-home', serverUrl: 'https://restricted-child.test' };
    const credentials = { token: 'restricted-session-bearer', encryption: null };
    const lifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = {
      inputId: 'restricted-input', turnId: 'restricted-turn', userMessageSeq: 1, userMessageSeqs: [1],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    };
    const controller = { kind: 'backend', controllerOccurrenceId: 'restricted-occurrence' } as Extract<ExecutionRunController, { kind: 'backend' }>;
    const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['restricted-run', controller]]));
    const occurrence = registry.register({ runId: 'restricted-run', sidechainId: 'restricted-sidechain', controller,
      runtimeLifetimeSignal: lifetime.signal, readActiveTurnAdmissionWitness: () => witness });
    const requests: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      requests.push(String(url));
      expect(config?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
      if (url !== `${home.serverUrl}/v2/sessions/${sessionId}`) throw new Error(`Unexpected restricted read: ${url}`);
      return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
        encryptionMode: 'plain', metadata: '{}', active: true }) } };
    });
    const parent = createMutableApiSessionClientFixture({ sessionId, metadata: createTestMetadata({}), overrides: {
      getServerBinding: () => home,
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } }, capabilities: {} }) }),
    } });
    const binding = await resolveRunnerMcpServers({ session: parent, credentials, accountCredentials: null,
      accountSettings: accountSettingsParse({}), machineId: 'restricted-machine', directory: '/restricted', env: {},
      sessionList: createRestrictedCurrentSessionListActionDependency({ credentials, sessionId,
        serverId: home.serverId, serverHttpBaseUrl: home.serverUrl, material: { mode: 'plain' } }),
      executionRun: { runId: 'restricted-run', workDepth: 1, cwd: '/restricted', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted, getPermissionMode: () => 'read-only',
        readActiveTurnAdmissionWitness: () => witness, readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence },
    });
    if (!binding.sessionMcpContext) throw new Error('Missing Session MCP context');
    const connection = await connectSessionMcpClient(binding.sessionMcpContext);
    const { client } = connection;
    try {
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.list', input: {} } }));
      expect(result.isError, JSON.stringify(result)).toBe(false);
      const content = result.content.find(block => block.type === 'text');
      if (content?.type !== 'text') throw new Error('Missing Session-list Action result');
      expect(JSON.parse(content.text)).toMatchObject({ sessions: [{ id: sessionId }], nextCursor: null, hasNext: false });
      expect(requests).toEqual([`${home.serverUrl}/v2/sessions/${sessionId}`]);
    } finally { await connection.close(); await binding.happierMcpServer.stop(); occurrence.dispose(); }
  });

  it.each([false, true])('keeps Run MCP catalog admission independent of parent Stop and settles its own Run cancellation (optional Account MCP: %s)', async optionalAccountMcp => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const parentTurn = new AbortController();
    const lifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = {
      inputId: 'run-catalog-input', turnId: 'run-catalog-turn', userMessageSeq: 1, userMessageSeqs: [1],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    };
    // Native controller identity is the provider boundary; occurrence ownership
    // and currentness are derived by the real registry, as in the adjacent test.
    const controller = { kind: 'backend', controllerOccurrenceId: 'run-catalog-occurrence' } as Extract<ExecutionRunController, { kind: 'backend' }>;
    const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['run-catalog', controller]]));
    const occurrence = registry.register({ runId: 'run-catalog', sidechainId: 'run-catalog-sidechain',
      controller, runtimeLifetimeSignal: lifetime.signal, readActiveTurnAdmissionWitness: () => witness });
    const notices: unknown[] = [];
    const parent = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'run-catalog-session', metadata: createTestMetadata({}), overrides: {
      enqueueSessionEventCommitted: async event => { notices.push(event); return { persisted: true, delivered: true }; },
    } }), {
      getHostTurnAbortSignal: () => parentTurn.signal,
    });
    const admitted = optionalAccountMcp ? await admittedSource(parent.sessionId) : null;
    const credentials = admitted?.credentials ?? { token: 'run-catalog-fixture', encryption: null };
    if (admitted) parent.getServerBinding = () => admitted.home;
    const settings = accountSettingsParse({ mcpServersStrictMode: false });
    const binding = await resolveRunnerMcpServers({
      session: parent, credentials, accountCredentials: optionalAccountMcp ? credentials : null,
      accountSettings: settings,
      ...(optionalAccountMcp ? { accountSettingsSnapshot: {
        source: 'network' as const, settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
        mcpServerCatalog: { status: 'unavailable' as const, reason: 'unreachable' as const },
      } } : {}),
      machineId: 'machine', directory: '/run/catalog', env: {},
      executionRun: { runId: 'run-catalog', workDepth: 1, cwd: '/run/catalog', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted, getPermissionMode: () => 'default',
        readActiveTurnAdmissionWitness: () => witness,
        readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence },
    });
    if (optionalAccountMcp) expect(readSessionCapabilityNoticeV1(notices[0])?.items[0])
      .toMatchObject({ code: 'mcp_catalog_unavailable', detail: 'unreachable' });
    if (!binding.sessionMcpContext) throw new Error('Missing Session MCP context');
    const connection = await connectSessionMcpClient(binding.sessionMcpContext);
    const { client } = connection;
    let entered = createDeferred<AbortSignal | undefined>();
    let release = createDeferred<void>();
    const holdCatalog = () => daemonCatalogBoundary.read.mockImplementation(async input => {
      entered.resolve(input?.signal);
      await new Promise<void>((resolve, reject) => {
        void release.promise.then(resolve);
        input?.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      });
      return { kind: 'available', plugins: [], tools: [] };
    });
    try {
      holdCatalog();
      const surviving = client.callTool({ name: 'action_spec_get', arguments: { id: 'browser.view.open' } });
      try {
        const sourceSignal = await entered.promise;
        expect(sourceSignal).toBeDefined();
        parentTurn.abort();
        expect(lifetime.signal.aborted).toBe(false);
        expect(sourceSignal?.aborted).toBe(false);
        release.resolve();
        expect(await surviving).toMatchObject({ isError: false });
      } finally { release.resolve(); await Promise.allSettled([surviving]); }
      entered = createDeferred<AbortSignal | undefined>();
      release = createDeferred<void>();
      holdCatalog();
      const cancelled = sessionMcpTestFetch(binding.happierMcpServer)(binding.happierMcpServer.url, { method: 'POST',
        headers: { ...sessionMcpAuthorizationHeaders(binding.happierMcpServer),
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'run-stop', method: 'tools/call',
          params: { name: 'action_spec_get', arguments: { id: 'browser.view.open' } } }),
      });
      try {
        const sourceSignal = await entered.promise;
        lifetime.abort();
        expect(sourceSignal?.aborted).toBe(true);
        const response = await cancelled;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ ok: false, errorCode: 'cancelled' });
      } finally { release.resolve(); await cancelled; }
    } finally { release.resolve(); await connection.close(); await binding.happierMcpServer.stop(); occurrence.dispose(); }
  });

  it('refreshes selected shared Saved Secrets before composing an Execution Run MCP profile', async () => {
    const { credentials, home } = await admittedSource('run-secret-admission', {
      readAdditionalHttpResponse: async url => new URL(url).pathname === '/v1/account/saved-secrets/resources/materials'
        ? { status: 200, data: { resources: [] } } : undefined,
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
      features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {},
    }))));
    const { token } = credentials;
    const resourceId = 'revoked-run-mcp-resource';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const accountSettings = accountSettingsParse({ mcpServersStrictMode: true });
    const catalog = McpServerCatalogV1Schema.parse({
        v: 1,
        servers: [{
          id: 'shared-run-server',
          name: 'shared-run-server',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: { API_KEY: { t: 'savedSecret', secretId: ref } },
          createdAt: 1,
          updatedAt: 1,
        }],
        bindings: [{
          id: 'shared-run-binding',
          serverId: 'shared-run-server',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        }],
    });
    const staleResource = {
      resourceId,
      ownerAccountId: 'owner-account',
      displayName: 'Revoked run key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 4,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1, name: 'Revoked run key', kind: 'apiKey', value: 'stale-value' },
      }),
      materialStatus: 'ready' as const,
    };
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettings,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [staleResource],
      mcpServerCatalog: { status: 'ready', authority: 'active', revision: 3, diagnostics: [], catalog },
    });

    await expect(resolveRunnerMcpServers({
      session: {
        sessionId: 'run-secret-admission',
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'run-secret-admission', encryptionMode: 'plain' }),
        updateMetadata: () => undefined,
        getServerBinding: () => home,
        enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      },
      credentials,
      isolationEnabled: false,
      accountSettings,
      accountSettingsSnapshot: getActiveAccountSettingsSnapshot(),
      savedSecretResources: [staleResource],
      machineId: 'machine',
      directory: '/run/a',
      env: {},
      tmpDir: null,
      executionRun: {
        runId: 'run-a',
        workDepth: 0,
        cwd: '/run/a',
        signal: new AbortController().signal,
        isCurrent: () => true,
        readActiveTurnAdmissionWitness: () => null,
        readCurrentRunOccurrence: () => null,
      },
    })).rejects.toMatchObject({
      code: 'saved_secret_resolution_failed',
      status: 'forbidden',
      reference: ref,
    });
  });

  it('keeps the parent profile but binds confirmation to this Run occurrence and admitted turn', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    const lifetime = new AbortController();
    const parentLifetime = new AbortController();
    const witness: AgentInvocationTurnAdmissionWitness = {
      inputId: 'input-run-a', turnId: 'turn-run-a', userMessageSeq: 3, userMessageSeqs: [3],
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    };
    const controller = {
      kind: 'backend',
      controllerOccurrenceId: 'run-a-occurrence-1',
    } as ExecutionRunController;
    const registry = createExecutionRunOccurrenceWitnessRegistry(new Map([['run-a', controller]]));
    const occurrence = registry.register({
      runId: 'run-a', sidechainId: 'sidechain-a', runtimeLifetimeSignal: lifetime.signal,
      controller: controller as Extract<ExecutionRunController, { kind: 'backend' }>,
      readActiveTurnAdmissionWitness: () => witness,
    });
    // A holder, not a `let`: narrowing across the MCP request boundary would
    // otherwise collapse the captured binding to `null` for the assertions below.
    const captured: { binding: SessionActionConfirmationRuntimeBinding | null } = { binding: null };
    const parent: Parameters<typeof resolveRunnerMcpServers>[0]['session'] = {
      sessionId: 'session-a',
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: true }),
      getServerBinding: () => ({
        serverId: 'test-home',
        serverUrl: 'https://test-home.example.test',
      }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'session-a', encryptionMode: 'plain' }),
      updateMetadata: () => undefined,
      getPermissionMode: () => 'yolo',
      getRuntimeLifetimeSignal: () => parentLifetime.signal,
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({
          features: {
            sharing: {
              enabled: true,
              session: { enabled: true },
            },
            sessions: {
              enabled: true,
              conversations: { enabled: true },
            },
          },
          capabilities: {},
        }),
      }),
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn-parent',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      }),
      confirmSessionAction: async (_request, binding) => {
        captured.binding = binding;
        return { decision: 'reject', isCurrent: () => true };
      },
    };
    const binding = await resolveRunnerMcpServers({
      session: parent,
      credentials: { token: 'runtime-test-token', encryption: null },
      accountSettings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: { 'session.terminalComposer.clear': { approvalRequiredSurfaces: ['agent'] } },
      } }),
      accountSettingsSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('runtime-test-token'),
        mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
          catalog: { v: 1, servers: [], bindings: [] } } },
      machineId: 'machine-a', directory: '/run/a',
      resolvedMcpServers: { extra: { command: 'authorized-tool', env: { SECRET: 'already-resolved' } } },
      executionRun: {
        runId: 'run-a', workDepth: 4, cwd: '/run/a', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted,
        getPermissionMode: () => 'default',
        readActiveTurnAdmissionWitness: () => witness,
        readCurrentRunOccurrence: registry.reader.readCurrentRunOccurrence,
      },
    });
    const client = new Client({ name: 'run-binding-test', version: '1' }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
      // Bound Session commands retain the Run's transient confirmation owner;
      // persisted activity reads now go through daemon Account admission.
      const result = await client.callTool({ name: 'action_execute', arguments: { actionId: 'session.terminalComposer.clear', input: { sessionId: 'session-a' } } });
      expect(captured.binding, JSON.stringify(result)).toMatchObject({
        turnId: 'turn-run-a',
        run: { runId: 'run-a', sidechainId: 'sidechain-a', occurrenceId: occurrence.occurrence.occurrenceId },
      });
      expect(binding.mcpServers.extra).toEqual({ command: 'authorized-tool', env: { SECRET: 'already-resolved' } });
      expect(binding.happierMcpServer.supportedSessionReadActions).toEqual([
        'session.transcript.get',
        'discussion.list',
        'discussion.get',
        'discussion.read',
      ]);
      expect(binding.happierMcpServer.supportedSessionReadActions).not.toContain('discussion.post');
      expect(parent.getActiveTurnPermissionWitness?.()?.turnId).toBe('turn-parent');
      expect(captured.binding?.isCurrent()).toBe(true);
      occurrence.dispose();
      expect(captured.binding?.isCurrent()).toBe(false);
    } finally {
      await client.close();
      binding.happierMcpServer.stop();
    }
  });
});
