import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import type { McpToolPolicyContext } from '@/mcp/runtime/resolveMcpToolIdentity';
import { assignMcpWireNames } from '@/mcp/runtime/assignMcpWireNames';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveMcpServerCatalogRefresh, getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActiveMcpServerCatalog, refreshActiveMcpServerCatalog,
  refreshActiveMcpServerCatalogAfterChange } from '@/settings/mcp/hydrateMcpServerCatalog';
import { createDeferred } from '@/testkit/async/deferred';

import type { DisposableCodexAppServerClient } from './client.js';
import { createCodexNativeEventFixture } from './client.test-support.js';
import { registerCodexAppServerInteractionHandlers } from './interactions.js';
import { assignInjectedServerKeys } from './config/overrides.js';
import { withCodexNativeAttachFixture } from './runtime.nativeAttach.test-support.js';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createCodexAppServerToolEventProjector } from './projection/toolEvents.js';
import { createAcpToolIdentity } from '@/agent/acp/toolCalls/identity';

// Isolate the OS-user startup lock, retaining the real client/socket/runtime.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

// Session state and authenticated RPC transport are the system boundaries; all
// interaction normalization, grant storage, and permission decisions stay real.
class ApprovalSession {
  readonly sessionId = 'session-approval-subject';
  readonly rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  state: AgentState = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() { return this.state; }
  getMetadataSnapshot() { return null; }
  updateAgentState(update: (state: AgentState) => AgentState) {
    this.state = update(this.state);
    return this.state;
  }
  async getAuthenticatedAccountId() { return 'account-owner'; }
}

function createFixture(options: Readonly<{
  mcpServerKeys?: ReadonlyMap<string, string>;
  getMcpToolContext?: () => McpToolPolicyContext;
  pluginId?: string;
}> = {}) {
  const session = new ApprovalSession();
  const permissionHandler = createProviderEnforcedPermissionHandler({
    session: session as unknown as ApiSessionClient,
    logPrefix: '[CodexApprovalSubjectTest]',
    // The host has admitted a writable session; tool grants still require approval.
    getWorkspaceWrites: () => 'allow',
    getMcpToolContext: options.getMcpToolContext,
  });
  const controller = new AbortController();
  const services = createNativeAgentSessionServices({
    permissionHandler,
    pluginId: options.pluginId ?? 'happier.codex',
    contributionId: 'codex',
    runtimeId: 'codex/runtime',
    sessionId: session.sessionId,
    occurrenceId: 'codex-occurrence',
    immutableGenerationId: 'codex-generation',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'codex-generation', installSource: 'npm' },
    isCurrent: () => true,
    signal: controller.signal,
  });
  const requests = new Map<string, Parameters<DisposableCodexAppServerClient['registerRequestHandler']>[1]>();
  const notifications = new Map<string, Set<(params: unknown) => void>>();
  const nativeReceipts = createCodexNativeEventFixture();
  const client: DisposableCodexAppServerClient = {
    onNativeEvent: nativeReceipts.onNativeEvent,
    request: vi.fn(async () => ({})),
    notify: vi.fn(async () => {}),
    registerRequestHandler(method, handler) {
      requests.set(method, handler);
      return () => requests.delete(method);
    },
    registerNotificationHandler(method, handler) {
      const handlers = notifications.get(method) ?? new Set();
      handlers.add(handler);
      notifications.set(method, handlers);
      return () => handlers.delete(handler);
    },
    onExit: () => () => {},
    dispose: vi.fn(async () => {}),
  };
  registerCodexAppServerInteractionHandlers({ client, ui: services.interactions, getThreadId: () => 'thread-1',
    mcpServerKeys: options.mcpServerKeys });
  const publish = (method: string, raw: unknown) => {
    nativeReceipts.publish(method, raw);
    for (const handler of notifications.get(method) ?? []) handler(raw);
  };
  return {
    session,
    stop: () => controller.abort(),
    publish,
    command(itemId: string) {
      const handler = requests.get('item/commandExecution/requestApproval');
      if (!handler) throw new Error('Missing command approval handler');
      return Promise.resolve(handler({ threadId: 'thread-1', turnId: 'turn-1', itemId,
        command: '/bin/bash -lc pwd', cwd: '/workspace' }, { id: 'rpc-command' }));
    },
    request(itemId: string, source?: { server: string; tool: string; arguments?: Record<string, unknown> }) {
      if (source) publish('item/started', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { id: itemId, type: 'mcpToolCall', arguments: {}, ...source },
      });
      const handler = requests.get('item/tool/requestUserInput');
      if (!handler) throw new Error('Missing Codex tool input handler');
      return Promise.resolve(handler({
        threadId: 'thread-1', turnId: 'turn-1', itemId,
        questions: [{
          id: 'mcp_tool_call_approval_1', header: 'Approval', question: 'Allow this MCP tool call?',
          isOther: false, isSecret: false,
          options: [
            { label: 'Approve Once', description: 'Run once' },
            { label: 'Approve this Session', description: 'Run for this session' },
            { label: 'Deny', description: 'Do not run' },
          ],
        }],
      }, { id: `rpc-${itemId}` }));
    },
    async pending() {
      await vi.waitFor(() => expect(Object.keys(session.state.requests ?? {})).toHaveLength(1));
      const entry = Object.entries(session.state.requests ?? {})[0]!;
      return { id: entry[0], request: entry[1] };
    },
    async respond(id: string, decision: 'approved' | 'approved_for_session' | 'denied') {
      const respond = session.rpcHandlerManager.handlers.get('permission');
      if (!respond) throw new Error('Missing authenticated permission RPC handler');
      await respond({ id, approved: decision !== 'denied', decision });
    },
  };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  resetActiveAccountSettingsSnapshotForTests();
});
// The host owns the Session grant. A native Session grant would skip the next
// host lookup and keep running a tool after the catalog turns it Off.
const approvedAnswer = { answers: { mcp_tool_call_approval_1: { answers: ['Approve Once'] } } };
const deniedAnswer = { answers: { mcp_tool_call_approval_1: { answers: ['Deny'] } } };

describe('Codex MCP approval subjects through real session grants', () => {
  it('correlates a native command approval with the command transcript identity', async () => {
    const f = createFixture();
    stops.push(f.stop);
    const answer = f.command('exec-native-command');
    const pending = await f.pending();
    expect(pending.id).toBe('exec-native-command');
    const state = createReducer();
    reducer(state, [], f.session.state);
    await f.respond(pending.id, 'approved');
    await expect(answer).resolves.toEqual({ decision: 'accept' });
    expect(f.session.state.completedRequests?.['exec-native-command']).toBeDefined();
    const projector = createCodexAppServerToolEventProjector();
    const command = { id: 'exec-native-command', type: 'commandExecution', command: '/bin/bash -lc pwd' };
    const calls = projector.project({ method: 'item/started', scopeId: 'turn-1', notificationParams: { item: command } });
    const results = projector.project({ method: 'item/completed', scopeId: 'turn-1', notificationParams: {
      item: { ...command, status: 'completed', aggregatedOutput: '/workspace\n', exitCode: 0 },
    } });
    const messages = [...calls, ...results].map((event, index) => {
      const { sidechainId: _sidechainId, ...body } = event;
      const identity = createAcpToolIdentity({ sessionId: f.session.sessionId, turnId: 'turn-1',
        sidechainId: null, toolCallId: event.callId });
      const message = normalizeRawMessage(`native-tool-${index}`, null, Date.now() + index, {
        role: 'agent', content: { type: 'acp', agentId: 'codex',
          data: { ...body, id: event.type === 'tool-call' ? identity.callLocalId : identity.resultLocalId } },
      });
      if (!message) throw new Error('Native tool output must satisfy the transcript consumer');
      return message;
    });
    reducer(state, messages, f.session.state);
    const tools = [...state.messages.values()].filter(message => message.tool);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.tool).toMatchObject({ id: 'exec-native-command', result: expect.objectContaining({ aggregatedOutput: '/workspace\n' }) });
  });

  it.each(['populated', 'empty', 'malformed'] as const)('publishes the native model list through the real host Session model publisher (%s)', async outcome => {
    let metadata: Metadata = createTestMetadata({ sessionModelsV1: {
      v: 1, agentId: 'codex', currentModelId: 'fixture-model',
      availableModels: [{ id: 'fixture-model', name: 'fixture-model' }], updatedAt: 0,
    } });
    const controller = new AbortController();
    const publications = createNativeAgentSessionPublications({ agentId: 'codex', session: null,
      signal: controller.signal, isCurrent: () => true, supportsInFlightSteer: true });
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'codex', source: publications.modelsSource,
      session: { getMetadataSnapshot: () => metadata,
        updateMetadataAsCurrentPublisher: updater => { metadata = updater(metadata); },
        on() {}, off() {} } });
    try {
      await withCodexNativeAttachFixture(async ({ openConfiguredSession }) => {
        await openConfiguredSession();
        await publisher.flush();
        const parsed = MetadataSchema.parse(metadata);
        if (outcome === 'malformed') {
          expect(parsed.sessionModelsV1).toMatchObject({ updatedAt: 0,
            availableModels: [{ id: 'fixture-model', name: 'fixture-model' }] });
          return;
        }
        expect(metadata.sessionModelsV1).toMatchObject({ currentModelId: 'fixture-model',
          availableModels: outcome === 'empty' ? [] : [expect.objectContaining({ id: 'fixture-model', name: 'Fixture Model' })] });
        expect(metadata.sessionModelsV1?.updatedAt).toBeGreaterThan(0);
      }, { models: publications.services.models,
        ...(outcome === 'empty' ? { modelListResponse: { data: [], nextCursor: null } }
          : outcome === 'malformed' ? { modelListResponse: { unexpected: [] } } : {}) });
    } finally { publisher.dispose(); publications.dispose(); controller.abort(); }
  });

  it('publishes the model accepted by the native turn rather than a later desired selection', async () => {
    const publications = createNativeAgentSessionPublications({ agentId: 'codex', session: null,
      signal: new AbortController().signal, isCurrent: () => true, supportsInFlightSteer: true });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    try {
      await withCodexNativeAttachFixture(async ({ openConfiguredSession, emitNotification }) => {
        const session = await openConfiguredSession();
        const sent = session.send({ inputIds: ['model-observation'], input: { text: 'Use the current model' },
          delivery: { kind: 'newTurn', turnId: 'model-turn' } });
        await entered.promise;
        await session.updateConfiguration({ mode: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {},
          model: { value: 'next-model', updatedAtMs: 2 } });
        release.resolve();
        await sent;
        expect(publications.modelsSource.read().currentModelId).toBe('fixture-model');
        emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
      }, { models: publications.services.models,
        beforeTurnStartResponse: async () => { entered.resolve(); await release.promise; } });
    } finally { release.resolve(); publications.dispose(); }
  });
  it.each(['in-flight', 'demanded', 'refresh-failed'] as const)(
    'waits for the real catalog owner after a revision change (%s) before publishing an MCP Ask',
    async phase => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-approval-owner' })).toString('base64url')}.signature`, encryption: null };
      let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{
        id: 'catalog-qa', name: 'qa-boot3', title: 'QA server', transport: 'http',
        remote: { url: 'https://fixture.invalid/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1,
        tools: { default: 'ask', overrides: {} },
        toolsSnapshot: { checkedAt: 1, machineId: 'machine', tools: [{ name: 'acknowledge', title: 'Acknowledge', tokens: 1 }] },
      }], bindings: [] });
      let revision = 1;
      const issued = createDeferred<void>();
      const release = createDeferred<void>();
      // Only authenticated Home HTTP is external. Catalog loading/publication,
      // wire naming, native projection and the host permission handler are real.
      const home = createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer ${credentials.token}`) {
          response.writeHead(401).end(); return;
        }
        const path = new URL(request.url ?? '/', 'http://home').pathname;
        response.setHeader('Content-Type', 'application/json');
        if (path === '/v1/account/entity-rows/mcp') {
          if (revision > 1) {
            issued.resolve(); await release.promise;
            if (phase === 'refresh-failed') { response.writeHead(503).end('{}'); return; }
          }
          response.end(JSON.stringify({ status: 'present', revision, content: { t: 'plain', v: catalog } })); return;
        }
        const data = path === '/v1/account/encryption/currentness' ? { mode: 'plain', version: 1, settingsVersion: 7,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
          : path === '/v2/account/settings' ? { version: 7, content: { t: 'plain', v: {} } }
          : path === '/v2/account/settings/history' ? { snapshots: [] }
          : path === '/v1/account/entity-rows/profiles/transfer' ? { status: 'absent' } : null;
        if (!data) response.statusCode = 404;
        response.end(JSON.stringify(data ?? {}));
      });
      home.listen(0, '127.0.0.1'); await once(home, 'listening');
      const address = home.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
      try {
        await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
          const scopeKey = resolveAccountSettingsScopeKey(credentials);
          setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
            settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
          const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
          await refreshActiveMcpServerCatalog({ credentials });
          const identities = assignMcpWireNames({ items: catalog.servers.map(server => ({
            name: server.name, serverId: server.id, serverTitle: server.title ?? server.name,
          })) });
          const mcpServerKeys = assignInjectedServerKeys(['happier', ...Object.keys(identities.mcpServerIdentities)]);
          const getMcpToolContext = () => ({
            mcpServerIdentities: identities.mcpServerIdentities,
            catalog: getActiveAccountSettingsSnapshot()?.mcpServerCatalog ?? null,
            prepareCatalog: () => prepareActiveMcpServerCatalog({ credentials, scopeKey, lifetimeToken }),
          });
          const fixture = createFixture({ pluginId: 'external.agent', mcpServerKeys, getMcpToolContext });
          let runRequest: { requestId: string; mcpTool?: unknown } | undefined;
          const run = createExecutionRunPermissionHandler({ backendId: 'external.agent', permissionMode: 'default',
            getMcpToolContext, publishPendingRequest: request => { runRequest = request; } });
          stops.push(fixture.stop);
          revision = 2;
          catalog = { ...catalog, servers: [{ ...catalog.servers[0]!, title: 'Updated QA server',
            remote: { url: 'https://updated-fixture.invalid/mcp', headers: {} }, updatedAt: 2 }] };
          // The owner marks the old revision loading before a native call.
          const refresh = phase === 'demanded' ? undefined
            : refreshActiveMcpServerCatalogAfterChange({ credentials, scopeKey, lifetimeToken });
          if (phase === 'demanded') beginActiveMcpServerCatalogRefresh({ scopeKey, lifetimeToken });
          const result = fixture.request('catalog-revision-change', {
            server: mcpServerKeys.get('qa-boot3')!, tool: 'acknowledge', arguments: { note: 'fixture' },
          });
          const runResult = run.handleToolCall('run-revision-change', 'mcp__qa-boot3__acknowledge', {});
          // On the broken demanded path the Ask publishes without ever demanding
          // a read. Release also when that public outcome wins, keeping RED finite.
          await Promise.race([issued.promise, fixture.pending()]);
          const prematureRequests = Object.keys(fixture.session.state.requests ?? {}).length;
          const prematureRunRequest = runRequest;
          release.resolve();
          await refresh;
          const pending = await fixture.pending();
          const identity = pending.request.mcpTool;
          await fixture.respond(pending.id, 'denied');
          await expect(result).resolves.toEqual(deniedAnswer);
          await vi.waitFor(() => expect(runRequest).toBeDefined());
          run.respondToPermissionRequest('run-revision-change', false);
          await expect(runResult).resolves.toEqual({ decision: 'denied' });
          if (phase === 'refresh-failed') expect(identity).toBeUndefined();
          else expect(ResolvedMcpToolIdentityV1Schema.parse(identity)).toMatchObject({
            server: 'qa-boot3', tool: 'acknowledge', item: { serverId: 'catalog-qa' },
            serverTitle: 'Updated QA server', decision: { approval: 'ask' },
          });
          if (phase === 'refresh-failed') expect(runRequest?.mcpTool).toBeUndefined();
          else expect(ResolvedMcpToolIdentityV1Schema.parse(runRequest?.mcpTool)).toEqual(identity);
          expect(prematureRequests).toBe(0);
          expect(prematureRunRequest).toBeUndefined();
          expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toMatchObject(phase === 'refresh-failed'
            ? { status: 'unavailable', reason: 'unreachable' } : { status: 'ready', revision: 2 });
        });
      } finally {
        release.resolve();
        await new Promise<void>(resolve => home.close(() => resolve()));
      }
    },
  );

  it.each(['loading', 'unavailable', 'missing-server', 'unknown-wire-key'] as const)(
    'asks without a persistent MCP identity when the catalog is %s, then resolves the admitted catalog id after recovery',
    async state => {
      const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{
        id: 'catalog-qa', name: 'qa-boot3', title: 'QA server', transport: 'stdio',
        stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
        tools: { default: 'ask', overrides: {} },
        toolsSnapshot: { checkedAt: 1, machineId: 'machine', tools: [{ name: 'acknowledge', title: 'Acknowledge', tokens: 1 }] },
      }], bindings: [] });
      const ready: McpServerCatalogSnapshotV1 = { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog };
      let current: McpServerCatalogSnapshotV1 = state === 'loading' ? { status: 'loading' }
        : state === 'unavailable' ? { status: 'unavailable', reason: 'unreachable' }
          : state === 'missing-server' ? { ...ready, catalog: { ...catalog, servers: [] } } : ready;
      // Consume the same host naming producer as launch: catalog ids are not wire keys.
      const identities = assignMcpWireNames({ items: catalog.servers.map(server => ({
        name: server.name, serverId: server.id, serverTitle: server.title ?? server.name,
      })) });
      const mcpServerKeys = assignInjectedServerKeys(['happier', ...Object.keys(identities.mcpServerIdentities)]);
      let admitted = state !== 'unknown-wire-key';
      const fixture = createFixture({ pluginId: 'external.agent', mcpServerKeys, getMcpToolContext: () => ({
        mcpServerIdentities: admitted ? identities.mcpServerIdentities : {}, catalog: current,
      }) });
      stops.push(fixture.stop);
      const source = { server: mcpServerKeys.get('qa-boot3')!, tool: 'acknowledge', arguments: { note: 'fixture' } };
      const result = fixture.request('unresolved', source);
      // Stop at either public outcome so an accidental auto-denial fails directly.
      await vi.waitFor(() => expect(Object.keys(fixture.session.state.requests ?? {}).length
        + Object.keys(fixture.session.state.completedRequests ?? {}).length).toBe(1));
      expect(Object.values(fixture.session.state.completedRequests ?? {})).toHaveLength(0);
      const pending = await fixture.pending();
      expect(pending.request.tool).toBe('mcp__qa-boot3__acknowledge');
      expect(pending.request.arguments).toEqual(source.arguments);
      expect(pending.request.mcpTool).toBeUndefined();
      await fixture.respond(pending.id, 'denied');
      await expect(result).resolves.toEqual(deniedAnswer);

      current = ready;
      admitted = true;
      const recovered = fixture.request('recovered', source);
      const resolved = await fixture.pending();
      expect(ResolvedMcpToolIdentityV1Schema.parse(resolved.request.mcpTool)).toMatchObject({
        server: 'qa-boot3', tool: 'acknowledge', item: { serverId: 'catalog-qa' }, decision: { approval: 'ask' },
      });
      await fixture.respond(resolved.id, 'denied');
      await expect(recovered).resolves.toEqual(deniedAnswer);
    },
  );

  it.each(['happier.codex', 'external.agent'])('resolves an injected server and its operands through %s host interactions', async pluginId => {
    const mcpServerKeys = assignInjectedServerKeys(['happier', 'qa-boot3']);
    const fixture = createFixture({ pluginId, mcpServerKeys, getMcpToolContext: () => ({
      mcpServerIdentities: { 'qa-boot3': { serverId: 'catalog-qa', serverTitle: 'QA server' } },
      catalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog: McpServerCatalogV1Schema.parse({ v: 1,
        servers: [{ id: 'catalog-qa', name: 'qa-boot3', title: 'QA server', transport: 'stdio',
          stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
          tools: { default: 'ask', overrides: {} }, toolsSnapshot: { checkedAt: 1, machineId: 'machine',
            tools: [{ name: 'acknowledge', title: 'Acknowledge', tokens: 1 }] } }], bindings: [] }) },
    }) });
    stops.push(fixture.stop);
    const operands = { note: 'Confirm the fixture' };
    const result = fixture.request('qa-call', {
      server: mcpServerKeys.get('qa-boot3')!, tool: 'acknowledge', arguments: operands,
    });
    const pending = await fixture.pending();
    expect(pending.request.tool).toBe('mcp__qa-boot3__acknowledge');
    expect(pending.request.arguments).toEqual(operands);
    expect(ResolvedMcpToolIdentityV1Schema.parse(pending.request.mcpTool)).toMatchObject({
      server: 'qa-boot3', tool: 'acknowledge', item: { serverId: 'catalog-qa' },
      serverTitle: 'QA server', toolTitle: 'Acknowledge', decision: { approval: 'ask' },
    });
    await fixture.respond(pending.id, 'denied');
    await expect(result).resolves.toEqual(deniedAnswer);
  });

  it('keeps a grant on one server/tool from approving a different tool or server', async () => {
    const fixture = createFixture();
    stops.push(fixture.stop);
    const first = fixture.request('call-a', { server: 'deployment', tool: 'create' });
    const pendingA = await fixture.pending();
    await fixture.respond(pendingA.id, 'approved_for_session');
    await expect(first).resolves.toEqual(approvedAnswer);

    const second = fixture.request('call-b', { server: 'deployment', tool: 'delete' });
    const pendingB = await fixture.pending();
    expect(pendingB.request.tool).toBe('mcp__deployment__delete');
    await fixture.respond(pendingB.id, 'denied');
    await expect(second).resolves.toEqual(deniedAnswer);

    const third = fixture.request('call-c', { server: 'other', tool: 'create' });
    const pendingC = await fixture.pending();
    expect(pendingC.request.tool).toBe('mcp__other__create');
    await fixture.respond(pendingC.id, 'denied');
    await expect(third).resolves.toEqual(deniedAnswer);

    expect(pendingA.request.tool).toBe('mcp__deployment__create');
    await expect(fixture.request('call-a-again', { server: 'deployment', tool: 'create' })).resolves.toEqual(approvedAnswer);
    expect(Object.keys(fixture.session.state.requests ?? {})).toHaveLength(0);
  });

  it('gives approvals without an MCP item a distinct subject for each call', async () => {
    const fixture = createFixture();
    stops.push(fixture.stop);
    const first = fixture.request('unknown-a');
    const pendingA = await fixture.pending();
    await fixture.respond(pendingA.id, 'approved_for_session');
    await expect(first).resolves.toEqual(approvedAnswer);
    const second = fixture.request('unknown-a');
    const pendingB = await fixture.pending();
    expect(pendingB.request.tool).not.toBe(pendingA.request.tool);
    await fixture.respond(pendingB.id, 'denied');
    await expect(second).resolves.toEqual(deniedAnswer);
  });

  it('ignores another thread and forgets completed item identities', async () => {
    const fixture = createFixture();
    stops.push(fixture.stop);
    fixture.publish('item/started', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'reused-item', type: 'mcpToolCall', server: 'deployment', tool: 'create' },
    });
    fixture.publish('item/started', {
      threadId: 'other-thread', turnId: 'turn-1',
      item: { id: 'reused-item', type: 'mcpToolCall', server: 'other', tool: 'delete' },
    });
    const first = fixture.request('reused-item');
    const pendingA = await fixture.pending();
    expect(pendingA.request.tool).toBe('mcp__deployment__create');
    await fixture.respond(pendingA.id, 'approved_for_session');
    await expect(first).resolves.toEqual(approvedAnswer);

    fixture.publish('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1', item: { id: 'reused-item', type: 'mcpToolCall' },
    });
    const second = fixture.request('reused-item');
    const pendingB = await fixture.pending();
    expect(pendingB.request.tool).not.toBe(pendingA.request.tool);
    await fixture.respond(pendingB.id, 'denied');
    await expect(second).resolves.toEqual(deniedAnswer);
  });
});
