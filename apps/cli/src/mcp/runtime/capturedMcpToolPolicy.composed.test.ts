import { once } from 'node:events';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { AgentSessionConfigurationUpdateV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createExecutionRunAccountSettingsSnapshotResolver } from '@/api/machine/resolveExecutionRunAccountSettingsSnapshot';
import { initializeSessionClientConnection } from '@/api/session/client/transport/initializeSessionClientConnection';
import { runSessionChangesSyncOnConnect } from '@/api/session/sessionChangesSyncOnConnect';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchChangesAccountId } from '@/api/changes';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { createNativeAgentSessionExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import type { AgentSessionConfigurationUpdate } from '@happier-dev/plugin-sdk/agents/runtime';
import { projectMcpToolLaunchPolicies } from './projectMcpToolLaunchPolicy';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

it('captured Account socket and reconnect row changes update Session and Run policy without borrowing ambient Home', async () => {
  const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
  const credentials = { token: token('foreign-owner'), encryption: null };
  let ownerCurrent = true;
  let unavailableStorage = false;
  let revision = 1;
  let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'docs-id', name: 'docs', transport: 'stdio', stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    tools: { default: 'allow_all', overrides: {} } }], bindings: [] };
  // Home HTTP and authenticated Account Socket.IO are real loopback boundaries.
  const home = createServer((request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
    response.setHeader('Content-Type', 'application/json');
    const path = new URL(request.url ?? '/', 'http://home').pathname;
    if (unavailableStorage && path === '/v1/account/encryption/currentness') {
      response.statusCode = 503; response.end('{}'); return;
    }
    const data = path === '/v1/account/encryption/currentness' ? { mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : path === '/v1/account/entity-rows/mcp' ? { status: 'present', revision, content: { t: 'plain', v: catalog } }
      : path === '/v2/account/settings' ? { version: 7, content: { t: 'plain', v: {} } }
      : path === '/v2/account/settings/history' ? { snapshots: [] }
      : path === '/v1/account/profile' ? { id: 'foreign-owner' }
      : path === '/v1/account/entity-rows/profiles/transfer' ? { status: 'absent' }
      : path === '/v2/changes' ? ChangesResponseSchema.parse({ changes: [{ cursor: revision, kind: 'account', entityId: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
        changedAt: revision, hint: { mcpServerCatalog: true, revision } }], nextCursor: revision }) : null;
    if (!data) response.statusCode = 404;
    response.end(JSON.stringify(data ?? {}));
  });
  const socketHome = new Server(home);
  socketHome.use((socket, next) => socket.handshake.auth.token === credentials.token ? next() : next(new Error('Wrong captured Account')));
  home.listen(0, '127.0.0.1'); await once(home, 'listening');
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home address');
  const url = `http://127.0.0.1:${address.port}`;
  const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'machine', serverHttpBaseUrl: url,
    readCredentials: async () => ownerCurrent ? credentials : null, isOwnerCurrent: () => true, onSettings() {} });
  const socket = io(url, { auth: { token: credentials.token }, extraHeaders: { Authorization: `Bearer ${credentials.token}` } });
  let connection: ReturnType<typeof initializeSessionClientConnection> | undefined;
  let nativeHost: ReturnType<typeof createNativeAgentSessionExecutionRunHostRuntime> | undefined;
  try {
    await resolver({ mcpServerCatalog: true });
    const operation = resolver.readOperationContext();
    if (!operation) throw new Error('Missing captured Account');
    const getMcpToolContext = () => ({ mcpServerIdentities: { docs: { serverId: 'docs-id', serverTitle: 'Docs' } }, catalog: operation.readSnapshot()?.mcpServerCatalog ?? null });
    const session = createMutableApiSessionClientFixture({ sessionId: 'foreign-session' });
    const handler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[foreign]', getWorkspaceWrites: () => 'allow', getMcpToolContext });
    const run = createExecutionRunPermissionHandler({ backendId: 'fixture', permissionMode: 'default', getMcpToolContext });
    const received: AgentSessionConfigurationUpdate[] = [];
    const projectPolicy = () => {
      const current = operation.readSnapshot()?.mcpServerCatalog;
      return projectMcpToolLaunchPolicies({ catalog: current?.status === 'ready' ? current.catalog : { v: 1, servers: [], bindings: [] },
        mcpServerIdentities: getMcpToolContext().mcpServerIdentities, control: { off: 'blocked', approval: 'native' }, permissionMode: 'default' });
    };
    nativeHost = createNativeAgentSessionExecutionRunHostRuntime({
      // Agent SDK and Session transport are fixtures. The captured Account,
      // context composition, projection and Session configuration owner are real.
      runtime: { sessions: { async open() { return { watch() { return { dispose() {} }; }, async send() { return { status: 'admitted' }; }, async dispose() {},
        async updateConfiguration(update) { received.push(AgentSessionConfigurationUpdateV1Schema.parse(update)); return { status: 'applied', changed: ['mcpToolPolicy'] }; } }; } } },
      lease: { pluginId: 'acme.foreign', pluginVersion: '1.0.0', agentId: 'acme.foreign/agent', localAgentId: 'agent', occurrenceId: 'foreign-native-run', isCurrent: () => true },
      options: { cwd: '/repo', runId: 'foreign-native-run', backendId: 'acme.foreign/agent', scope: 'session_owned', permissionMode: 'default',
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {} },
        start: { intent: 'delegate', runClass: 'bounded', retentionPolicy: 'ephemeral' } }, supportsResume: false,
      createSessionContext: async ({ services, signal }) => ({ ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        mcpToolPolicy: projectPolicy(), subscribeMcpToolPolicy: listener => operation.subscribeMcpCatalog(() => {
          const policy = projectPolicy(); if (policy) listener(policy);
        }) }),
    });
    await nativeHost.provisionRuntime({ initialPrompt: 'prepared' });
    expect(handler.getImmediateDecision('before', 'mcp__docs__write', {})).toMatchObject({ decision: 'approved' });
    expect(run.getImmediateDecision('before', 'mcp__docs__write', {})).toMatchObject({ decision: 'approved' });
    const focused = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey({ token: token('different-home-owner'), encryption: null }) };
    setActiveAccountSettingsSnapshot(focused);
    const incumbent = getActiveAccountSettingsSnapshot();
    let lastRefresh: Promise<void> | undefined;
    let followWakes = 0;
    let updates = 0;
    connection = initializeSessionClientConnection({ token: credentials.token, sessionId: session.sessionId, userScopedAccountUpdates: true,
      transport: { serverId: 'foreign-home', serverUrl: url, createAccountUpdatesSocket: () => socket,
        createSessionSocketTransport() { throw new Error('Unexpected Session transport demand'); } },
      getMetadataSnapshot: session.getMetadataSnapshot, setSessionSocket() {}, rpcHandlerManager: { onSocketConnect() {}, onSocketDisconnect() {} },
      handleUserScopedUpdate() { updates++; }, installSessionSocketEventHandlers() {}, classifyTransportErrorToProbeResult: undefined, onStateChange() {},
      shouldKeepUserSocketConnected: () => true, kickUserSocketConnect() {}, syncChangesOnConnect: async () => {}, shouldSyncSessionSnapshotOnConnect: () => false,
      syncSessionSnapshotFromServer: async () => {}, flushDurableSessionMutationsOnReconnect: async () => {}, markConnected: () => 'connect',
      onSessionFollowInvalidated() { followWakes++; }, onAccountCatalogInvalidated() { lastRefresh = resolver.refreshDemandedMcpCatalog(); return lastRefresh; },
    });
    if (!socket.connected) await once(socket, 'connect');
    revision++; catalog = { ...catalog, servers: [{ ...catalog.servers[0]!, tools: { default: 'allow_all', overrides: { write: 'off' } } }] };
    const updateReceived = once(socket, 'update');
    socketHome.emit('update', { id: 'row-changed', seq: revision, createdAt: revision, body: { t: 'account-change' } });
    await updateReceived; await lastRefresh;
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ permissionIntent: { value: 'default', updatedAtMs: 1 }, mcpToolPolicy: { docs: { unlisted: 'allow', tools: { write: 'off' } } } });
    expect(handler.getImmediateDecision('off', 'mcp__docs__write', {})).toMatchObject({ decision: 'denied' });
    expect(run.getImmediateDecision('off', 'mcp__docs__write', {})).toMatchObject({ decision: 'denied' });
    revision++; catalog = { ...catalog, servers: [{ ...catalog.servers[0]!, tools: { default: 'ask', overrides: {} } }] };
    let cursor = 1;
    await runWithServerHttpBaseUrl(url, () => runSessionChangesSyncOnConnect({ reason: 'reconnect', token: credentials.token, sessionId: session.sessionId, lastObservedMessageSeq: 0,
      getAccountId: () => fetchChangesAccountId({ token: credentials.token }), readChangesCursor: async accountId => {
        expect(accountId).toBe('foreign-owner'); return cursor;
      }, writeChangesCursor: async (accountId, next) => { expect(accountId).toBe('foreign-owner'); cursor = next; },
      catchUpSessionMessages: async () => { throw new Error('Unexpected transcript catch-up'); }, syncSessionSnapshotFromServer: async () => { throw new Error('Unexpected Session snapshot'); },
      refreshDemandedAccountCatalogs: resolver.refreshDemandedMcpCatalog, onDebug() {} }));
    expect(handler.getImmediateDecision('ask', 'mcp__docs__write', {})).toBeNull();
    expect(run.getImmediateDecision('ask', 'mcp__docs__write', {})).toBeNull();
    expect(cursor).toBe(revision);
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    // An Account-catalog change is unrelated to this Session's Follow context; only its own change kinds wake it.
    expect(followWakes).toBe(0); expect(updates).toBe(1);
    unavailableStorage = true;
    let acknowledgedAfterMcpFailure = false;
    await runWithServerHttpBaseUrl(url, () => runSessionChangesSyncOnConnect({ reason: 'reconnect', token: credentials.token, sessionId: session.sessionId, lastObservedMessageSeq: 0,
      getAccountId: () => fetchChangesAccountId({ token: credentials.token }), readChangesCursor: async () => 1,
      writeChangesCursor: async () => { acknowledgedAfterMcpFailure = true; }, catchUpSessionMessages: async () => {}, syncSessionSnapshotFromServer: async () => true,
      refreshDemandedAccountCatalogs: resolver.refreshDemandedMcpCatalog, onDebug() {} }));
    expect(acknowledgedAfterMcpFailure).toBe(true);
    expect(operation.readSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
    // Lost catalog authority cannot reuse a persistent Allow. Both real
    // interactive handlers defer to a fresh prompt rather than auto-approving.
    expect(handler.getImmediateDecision('unavailable', 'mcp__docs__write', {})).toBeNull();
    expect(run.getImmediateDecision('unavailable', 'mcp__docs__write', {})).toBeNull();
    unavailableStorage = false;
    await resolver.refreshDemandedMcpCatalog();
    ownerCurrent = false;
    await expect(resolver.refreshDemandedMcpCatalog()).rejects.toMatchObject({ code: 'provider_authorization_changed' });
    expect(operation.readSnapshot()).toBeNull();
    expect(handler.getImmediateDecision('retired', 'mcp__docs__write', {})).toBeNull();
  } finally {
    await nativeHost?.dispose(); await resolver.dispose(); resetActiveAccountSettingsSnapshotForTests(); socket.disconnect();
    await connection?.sessionConnectionSupervisor.stop(); await new Promise<void>(resolve => socketHome.close(() => resolve()));
  }
});
