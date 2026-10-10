import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountSettingsParse, deriveSessionCreationTagV1, FeaturesResponseSchema, SessionCreationCorrespondenceV1Schema, SessionInputRequestSchema } from '@happier-dev/protocol';
import { encrypt, decrypt, encodeBase64 } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import * as daemonControlClient from '@/daemon/controlClient';

const env = process.env;

const getTestServerBinding = () => ({
  serverId: 'test-home',
  serverUrl: 'https://test-home.example.test',
} as const);

async function installAccountCatalogDaemonTransport(params: Readonly<{
  sessionId: string;
  readMetadata: () => Readonly<Record<string, unknown>> | null;
  mode?: 'plain' | 'e2ee';
}>) {
  const mode = params.mode ?? 'plain';
  const secret = new Uint8Array(32).fill(17);
  const credentials = { token: 'catalog-test-token', encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
  const app = fastify();
  const restore = installAxiosFastifyAdapter({ app, origin: getTestServerBinding().serverUrl });
  let sessionReads = 0;
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
  app.get('/v2/sessions/:sessionId', async (_request, reply) => {
    sessionReads += 1;
    const metadata = params.readMetadata();
    if (!metadata) return reply.code(404).send({ error: 'not_found' });
    return { session: createSessionRecordFixture({ id: params.sessionId, encryptionMode: mode,
      metadata: mode === 'plain' ? JSON.stringify(metadata) : encodeBase64(encrypt(secret, 'legacy', metadata)),
    }) };
  });
  const executor = createCliActionExecutorFromCredentials({
    credentials, serverId: getTestServerBinding().serverId, serverApiUrl: getTestServerBinding().serverUrl,
    pluginActionExecutionOwner: 'current_process',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
      features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
  });
  // Only daemon IPC and Home HTTP are substituted. The credentialed daemon
  // catalog, current Session metadata opening and availability stay real.
  vi.spyOn(daemonControlClient, 'requestDaemonPluginActionExecution').mockImplementation(async (request) => {
    const result = await executor.execute(ActionIdSchema.parse(request.actionId), request.input, {
      surface: request.surface, authority: 'account_automation', actionCaller: { kind: 'host' },
      ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
    });
    return { matched: true, result: result.ok
      ? { ok: true, result: StrictJsonValueSchema.parse(result.result) }
      : { ok: false, errorCode: result.errorCode, error: result.error } };
  });
  return { executor, getSessionReads: () => sessionReads, close: async () => { restore(); await app.close(); } };
}

const catalogHostTurn = {
  getWorkDepth: () => 0,
  getHostTurnWorkDepth: (turnId: string) => turnId === 'catalog-turn' ? 0 : undefined,
  getActiveTurnPermissionWitness: () => ({ turnId: 'catalog-turn',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }),
};

function resetEnvironment() {
  process.env = { ...env };
  delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
}

function unmockCaseModules() {
  vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
  vi.doUnmock('@happier-dev/protocol');
  vi.doUnmock('@/session/actions/createCliActionExecutorHarness');
  vi.doUnmock('@/mcp/server/registerHappierMcpBuiltInTools');
  vi.doUnmock('@/agent/tools/happierTools/dispatchBuiltInHappierTool');
  vi.doUnmock('@/session/discussions/sessionDiscussionActionDeps');
  vi.doUnmock('@/api/accountServerActionDeps');
  vi.doUnmock('@/api/sessionFollowActionDeps');
}

describe('createHappierMcpServer real host admission', () => {
  // These cases create fresh clients/transports and restore their HTTP adapter.
  // No module mocks change between them. Load the real graph during collection,
  // so compilation cannot outlive a test and overlap its HTTP adapter lifetime.
  beforeEach(resetEnvironment);
  afterEach(unmockCaseModules);
  afterEach(() => vi.restoreAllMocks());

  it('keeps descriptive catalog reads at the bound Session host policy owner', async () => {
    delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    const sessionId = 'c111111111111111111111111';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId,
      readMetadata: () => ({ ...createTestMetadata(), work: { memoryEnabled: false } }),
    });
    const runtime = createHappierMcpServer({
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => ({ ...createTestMetadata(), work: { memoryEnabled: false } }),
      ...catalogHostTurn,
    });
    try {
      await expect(runtime.executeTool({ toolName: 'action_spec_get', args: { id: 'memory.search' } }))
        .resolves.toEqual(expect.objectContaining({ ok: true,
          result: expect.objectContaining({ actionSpec: expect.objectContaining({ id: 'memory.search' }) }),
        }));
      const search = await runtime.executeTool({ toolName: 'action_spec_search', args: { query: 'memory', limit: 100 } });
      expect(search).toEqual(expect.objectContaining({ ok: true }));
      if (search.ok) {
        const result = z.object({ actionSpecs: z.array(z.object({ id: z.string() })) }).parse(search.result);
        expect(result.actionSpecs.map((spec) => spec.id)).toContain('memory.search');
      }
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it.each(['plain', 'e2ee'] as const)('uses live Session memory choice for direct tools, discovery and generic write admission (%s)', async (mode) => {
    let memoryEnabled = true;
    const actionsSettingsV1 = { v: 1, actions: {
      'memory.remember': { toolExposureModes: { agent: 'direct' } },
      'memory.update': { toolExposureModes: { agent: 'direct' } },
      'memory.forget': { toolExposureModes: { agent: 'direct' } },
    } };
    const sessionId = 'c222222222222222222222222';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, mode,
      readMetadata: () => ({ ...createTestMetadata(), work: { memoryEnabled } }),
    });
    const client = {
      sessionId,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => ({ ...createTestMetadata(), work: { memoryEnabled } }),
      ...catalogHostTurn,
    };
    const runtime = createHappierMcpServer(client, { accountSettings: accountSettingsParse({ actionsSettingsV1 }) });
    const execute = (toolName: string, args: unknown) => runtime.executeTool({ toolName, args });
    try {
      expect(runtime.toolNames).toEqual(expect.arrayContaining(['memory_remember', 'memory_update', 'memory_forget']));
      await expect(execute('action_spec_get', { id: 'memory.remember' })).resolves.toEqual(expect.objectContaining({
        ok: true, result: expect.objectContaining({ actionSpec: expect.objectContaining({ id: 'memory.remember' }) }),
      }));
      memoryEnabled = false;
      for (const id of ['memory.remember', 'memory.update', 'memory.forget'] as const) {
        await expect(execute('action_spec_get', { id })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await expect(execute('action_execute', { actionId: id, input: {} })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        await expect(execute(id.replace('.', '_'), {})).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
      }
      const search = await execute('action_spec_search', { query: 'memory', limit: 100 });
      expect(search).toEqual(expect.objectContaining({ ok: true }));
      if (search.ok) {
        const result = z.object({ actionSpecs: z.array(z.object({ id: z.string() })) }).parse(search.result);
        const ids = result.actionSpecs.map((spec) => spec.id);
        for (const id of ['memory.remember', 'memory.update', 'memory.forget']) expect(ids).not.toContain(id);
      }
      const refreshed = createHappierMcpServer(client, { accountSettings: accountSettingsParse({ actionsSettingsV1 }) });
      try {
        for (const name of ['memory_remember', 'memory_update', 'memory_forget']) expect(refreshed.toolNames).not.toContain(name);
        expect(refreshed.toolNames).toContain('change_title');
      } finally { await refreshed.mcp.close(); }
      memoryEnabled = true;
      await expect(execute('action_spec_get', { id: 'memory.remember' })).resolves.toMatchObject({
        ok: true, result: { actionSpec: { id: 'memory.remember' } },
      });
    } finally { await runtime.mcp.close(); await daemon.close(); }
  });

  it('refuses catalog disclosure when bound Session metadata is unavailable without restricting unbound Account discovery', async () => {
    const sessionId = 'c333333333333333333333333';
    const daemon = await installAccountCatalogDaemonTransport({ sessionId, readMetadata: () => null });
    try {
      await expect(daemon.executor.execute('action.spec.get', { id: 'memory.remember' }, { surface: 'mcp' }))
        .resolves.toEqual(expect.objectContaining({ ok: true }));
      expect(daemon.getSessionReads()).toBe(0);
      for (const actionId of ['action.spec.get', 'action.spec.search'] as const) {
        await expect(daemon.executor.execute(actionId, actionId === 'action.spec.get' ? { id: 'memory.remember' } : { query: 'memory' },
          { surface: 'agent', defaultSessionId: sessionId, actionCaller: { kind: 'host' } }))
          .resolves.toEqual(expect.objectContaining({ ok: false, errorCode: 'target_unavailable' }));
      }
    } finally { await daemon.close(); }
  });

  it('refuses native memory windows on credentialless Session-bound MCP before transport', async () => {
    const manager = new RpcHandlerManager({ scopePrefix: 'bound-session', encryptionMode: 'plain' });
    const requests: unknown[] = [];
    manager.registerHandler(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, async request => {
      requests.push(request);
      return { v: 1, snippets: [], citations: [], externalSnippets: [] };
    });
    const runtime = createHappierMcpServer({ sessionId: 'bound-session', rpcHandlerManager: manager,
      updateMetadata() {}, getServerBinding: getTestServerBinding,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
    }, { credentials: null, accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'memory.get_window': { toolExposureModes: { agent: 'direct' } },
    } } }) });
    try {
      expect(await runtime.executeTool({ toolName: 'memory_get_window', args: {
        machineId: 'machine-1', source: { type: 'external_transcript', agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' },
        sourceItemId: 'message',
      } })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
      expect(requests).toEqual([]);
    } finally { await runtime.mcp.close(); }
  });

  it.each(['mixed-corpus', 'documents-only'] as const)('keeps credentialless %s searches within the MCP-bound Session', async (selection) => {
    const manager = new RpcHandlerManager({ scopePrefix: 'bound-session', encryptionMode: 'plain' });
    const queries: unknown[] = [];
    manager.registerHandler(RPC_METHODS.DAEMON_MEMORY_SEARCH, async (query: unknown) => {
      queries.push(query);
      return { v: 1, ok: true, documents: { state: 'ready' }, hits: [
        { sessionId: 'bound-session', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, summary: 'readable', score: 1 },
        { sessionId: 'foreign-session', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1, summary: 'private transcript', score: 1 },
        { type: 'artifact', ref: { kind: 'doc', serverId: 'test-home', artifactId: 'doc-1' },
          revision: { headerVersion: 1, bodyVersion: 1 }, location: 'document', summary: 'private document', score: 1 },
      ] };
    });
    const runtime = createHappierMcpServer({
      sessionId: 'bound-session', rpcHandlerManager: manager, updateMetadata() {},
      getServerBinding: getTestServerBinding,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
    }, { credentials: null, accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'memory.search': { toolExposureModes: { agent: 'direct' } },
    } } }) });
    try {
      const result = await runtime.executeTool({ toolName: 'memory_search', args: {
        query: { v: 1, query: 'private', scope: { type: 'global' }, mode: 'deep',
          corpora: selection === 'mixed-corpus' ? ['sessions', 'documents'] : ['documents'] },
      } });
      expect(result).toEqual({ ok: true, result: {
        v: 1, ok: true, hits: selection === 'mixed-corpus' ? [{ sessionId: 'bound-session', seqFrom: 1, seqTo: 1,
          createdAtFromMs: 1, createdAtToMs: 1, summary: 'readable', score: 1 }] : [], documents: { state: 'unavailable' },
      } });
      expect(queries).toHaveLength(selection === 'mixed-corpus' ? 1 : 0);
      expect(JSON.stringify(result)).not.toContain('private transcript');
      expect(JSON.stringify(result)).not.toContain('private document');
    } finally { await runtime.mcp.close(); }
  });

  it('returns the daemon authority refusal for an advertised Account Action from a session-scoped runtime', async () => {
    delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    const sessionId = 'session-account-authority';
    const runtime = createHappierMcpServer({
      sessionId,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getServerBinding: getTestServerBinding,
      getServerFeaturesSnapshot: () => ({
        status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
      }),
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn-account', inputId: 'input-account', userMessageSeq: 1, userMessageSeqs: [1],
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      }),
    }, {
      authorityScope: 'session',
      sessionCredentials: { token: 'restricted-session-token', encryption: null },
    });
    const result = await runtime.executeTool({ toolName: 'action_execute', args: {
      actionId: 'notifications.notify_me', input: { message: 'Session notification' },
    } });
    expect(JSON.stringify(result)).toContain('target_unavailable');
    expect(JSON.stringify(result)).not.toContain('action_disabled');
    expect(JSON.stringify(result)).not.toContain('content_unavailable');
  });

  it.each([
    ['plain', false, 1, 2], ['e2ee', false, 1, 2], ['plain', true, 1, 2], ['e2ee', true, 1, 2],
    ['plain', false, 3, 0],
  ] as const)('admits a %s cross-session send from the real MCP host (background run: %s; starter depth: %s; turn depth: %s)', async (mode, backgroundRun, starterDepth, turnDepth) => {
    const origin = 'http://cross-session-home.test';
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const secret = new Uint8Array(32).fill(17);
    const credentials = { token: 'cross-session-token', encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
    const targetId = 'target-session-b';
    const targetMetadata = {
      sessionCreationCorrespondenceV1: SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag: deriveSessionCreationTagV1({
          callerCreationNamespace: 'mcp-host-admission-test', creationKey: targetId,
        }),
        recipe: {
          execution: { machineId: 'target-machine', directory: { kind: 'path', path: '/repo' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          modelSelection: null, profileId: null, requestedPermissionMode: null,
          agentModeId: null, configuration: null, connectedServices: null,
          mcpSelection: null, transcriptStorage: null, terminal: null,
          agentSessionStartupInstructionsMarkerV1: null, checkout: null,
        },
      }),
    };
    const admitted: Parameters<NonNullable<import('@/api/session/sessionClient').ApiSessionClientOptions['machineAdmissionTransport']>>[0][] = [];
    const features = { status: 'ready' as const, provenance: 'authenticated' as const, features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
    app.get('/v1/account/settings', async () => ({ settings: null, settingsVersion: 0 }));
    app.get('/v2/sessions/:sessionId', async () => ({ session: createSessionRecordFixture({
      id: targetId, active: true, encryptionMode: mode,
      metadata: mode === 'plain' ? JSON.stringify(targetMetadata) : encodeBase64(encrypt(secret, 'legacy', targetMetadata)),
    }) }));
    app.get('/v1/projects', async () => ({ projects: [] }));
    // Like ApiSessionClient, this carrier owns the transport on its prototype.
    // Only HTTP and authenticated Machine admission are substituted boundaries.
    class SessionCarrier {
      sessionId = 'source-session-a';
      rpcHandlerManager = new RpcHandlerManager({ scopePrefix: this.sessionId, encryptionMode: 'plain' });
      updateMetadata() {}
      getServerBinding() { return { serverId: 'cross-session-home', serverUrl: origin }; }
      getServerFeaturesSnapshot() { return features; }
      getPermissionMode() { return 'yolo' as const; }
      getWorkDepth() { return starterDepth; }
      getHostTurnWorkDepth(turnId: string) { return turnId === 'source-turn-a' ? turnDepth : undefined; }
      getBackendTarget() { return { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const; }
      getCurrentSessionLocation() { return { machineId: 'source-machine', path: '/repo' }; }
      getActiveTurnPermissionWitness() { return { turnId: 'source-turn-a', causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }; }
      getMachineAdmissionTransport() {
        return async (request: typeof admitted[number]) => {
          admitted.push(request);
          return { status: 'accepted' as const, localId: request.localId };
        };
      }
    }
    const source = new SessionCarrier();
    let stop: (() => void) | undefined;
    const client = new Client({ name: 'cross-session-test', version: '1' }, { capabilities: {} });
    // The real daemon has one active Home. Session reads resolve that process
    // endpoint; the fixture must initialize it as well as the Session binding.
    const releaseHome = publishServerHttpRuntimeOrigin(origin, 'https');
    try {
      const runtime = backgroundRun ? null : createHappierMcpServer(source, { credentials });
      if (backgroundRun) {
        const signal = new AbortController().signal;
        const readRunWitness = (): import('@/plugins/runtime/invocation/services/types').AgentInvocationTurnAdmissionWitness => ({
          inputId: 'run-input', turnId: 'run-turn', userMessageSeq: 1, userMessageSeqs: [1],
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
        });
        const binding = await resolveRunnerMcpServers({
          session: source, credentials, accountSettings: accountSettingsParse({}),
          machineId: 'source-machine', directory: '/repo', resolvedMcpServers: {},
          executionRun: {
            runId: 'background-run-a', workDepth: 4, cwd: '/repo', signal, isCurrent: () => true,
            readActiveTurnAdmissionWitness: readRunWitness,
            // Provider/runtime boundary: the Run owns its live occurrence and turn.
            readCurrentRunOccurrence: () => ({
              runId: 'background-run-a', sidechainId: 'run-sidechain', occurrenceId: 'run-occurrence',
              runtimeLifetimeSignal: signal, isCurrent: () => true, readActiveTurnAdmissionWitness: readRunWitness,
            }),
          },
        });
        stop = binding.happierMcpServer.stop;
        await client.connect(new StreamableHTTPClientTransport(new URL(binding.happierMcpServer.url)));
      }
      const args = { actionId: 'session.message.send', input: { sessionId: targetId, message: 'Hello from A', localId: 'u1-send' } };
      const result = runtime
        ? await runtime.executeTool({ toolName: 'action_execute', args })
        : await client.callTool({ name: 'action_execute', arguments: args });
      expect(JSON.stringify(result)).toContain('accepted');
      expect(admitted).toHaveLength(1);
      const request = admitted[0]!;
      expect(request.targetMachineId).toBe('target-machine');
      const content = request.content.t === 'plain' ? request.content.v : decrypt(secret, 'legacy', Uint8Array.from(Buffer.from(request.content.c, 'base64')));
      // Protected admission facts travel inside the sealed record, not as a
      // caller-controlled field on the Machine transport envelope.
      const record = z.object({ meta: z.object({ happierInputRequestV1: SessionInputRequestSchema }) }).parse(content);
      expect(record.meta.happierInputRequestV1.sourceSession).toMatchObject({
        sourceSessionId: source.sessionId, sourceTurnId: backgroundRun ? 'run-turn' : 'source-turn-a',
      });
      expect(content).toMatchObject({
        content: { type: 'text', text: 'Hello from A' },
        meta: { happierProvenanceV1: {
          v: 1, kind: 'happierSession', sourceSessionId: source.sessionId, via: 'mcp',
          callerDepth: backgroundRun ? 4 : Math.max(starterDepth, turnDepth),
        } },
      });
      const projects = runtime
        ? await runtime.executeTool({ toolName: 'action_execute', args: { actionId: 'projects.list', input: {} } })
        : await client.callTool({ name: 'action_execute', arguments: { actionId: 'projects.list', input: {} } });
      expect(JSON.stringify(projects)).toContain('projects');
      expect(JSON.stringify(projects)).not.toContain('action_disabled');
      if (backgroundRun) {
        const start = await client.callTool({ name: 'execution_run_start', arguments: {
          intent: 'review', backendTarget: source.getBackendTarget(), instructions: 'Review the change',
          permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        } });
        // Parent depth is 1, but this Run is at the limit (4): the real MCP ->
        // Action -> admission path must not start a child at the parent's depth.
        expect(JSON.stringify(start)).toContain('work_depth_exceeded');
      }
    } finally {
      await client.close();
      stop?.();
      releaseHome();
      restore();
      await app.close();
    }
  });

  it('refuses a child start from the exact host turn at depth four even when the Session started at zero', async () => {
    const client = {
      sessionId: 'depth-zero-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'depth-zero-session', encryptionMode: 'plain' }),
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => createTestMetadata({ path: '/repo', machineId: 'machine-a' }),
      getCurrentSessionLocation: () => ({ path: '/repo', machineId: 'machine-a' }),
      getBackendTarget: () => ({ kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const }),
      getPermissionMode: () => 'yolo' as const,
      getWorkDepth: () => 0,
      getHostTurnWorkDepth: (turnId: string) => turnId === 'depth-four-turn' ? 4 : undefined,
      getActiveTurnPermissionWitness: () => ({
        turnId: 'depth-four-turn',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const },
      }),
    } satisfies import('@/mcp/startHappyServer').HappyMcpSessionClient;
    const runtime = createHappierMcpServer(client, {
      credentials: null,
      accountSettings: accountSettingsParse({ workDepthLimit: 4 }),
    });
    const result = await runtime.executeTool({
      toolName: 'action_execute',
      args: { actionId: 'execution.run.start', input: {
        sessionId: client.sessionId,
        intent: 'delegate',
        backendTarget: client.getBackendTarget(),
        instructions: 'Start another worker.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'work_depth_exceeded' });
  });
});

describe('createHappierMcpServer', () => {
  // These existing fixtures replace imported collaborators with per-case mocks.
  // Keep their module isolation; unmocking alone cannot change cached imports.
  beforeEach(() => {
    vi.resetModules();
    resetEnvironment();
  });
  afterEach(unmockCaseModules);

  it('wires Account-server, Pool, Follow, and Discussion owners into the authenticated in-session Agent host', async () => {
    const captured: { params?: Record<string, unknown>; overrides?: Record<string, unknown> } = {};
    const accountInputs: Array<Record<string, unknown>> = [];
    const followInputs: Array<Record<string, unknown>> = [];
    const discussionInputs: Array<Record<string, unknown>> = [];
    const machinePoolAction = vi.fn();
    const homeDomainAction = vi.fn();
    const sessionFollowGet = vi.fn();
    const sessionDiscussionAction = vi.fn();
    const resolveServerFeaturesSnapshot = vi.fn(() => ({
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: {
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'stable-home-identity' } },
      },
    }));

    vi.doMock('@/api/accountServerActionDeps', () => ({
      createAccountServerActionDeps: (input: Record<string, unknown>) => {
        accountInputs.push(input);
        return { machinePoolAction, homeDomainAction };
      },
    }));
    vi.doMock('@/api/sessionFollowActionDeps', () => ({
      createSessionFollowActionDeps: (input: Record<string, unknown>) => {
        followInputs.push(input);
        return { sessionFollowGet };
      },
    }));
    vi.doMock('@/session/discussions/sessionDiscussionActionDeps', () => ({
      createSessionDiscussionActionDeps: (input: Record<string, unknown>) => {
        discussionInputs.push(input);
        return { sessionDiscussionAction };
      },
    }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>, overrides: Record<string, unknown>) => {
        captured.params = params;
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const credentials = { token: 'agent-account-token', encryption: null } as const;
    createHappierMcpServer({
      sessionId: 'sess_account_actions_1',
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getServerBinding: () => ({
        serverId: 'session-home-b',
        serverUrl: 'https://session-home-b.example.test',
      }),
      getServerFeaturesSnapshot: resolveServerFeaturesSnapshot,
    } as any, { credentials });

    expect(accountInputs).toHaveLength(1);
    expect(followInputs).toHaveLength(1);
    expect(accountInputs[0]).toMatchObject({ token: credentials.token, credentials });
    expect(accountInputs[0]).toMatchObject({
      serverId: 'session-home-b',
      serverHttpBaseUrl: 'https://session-home-b.example.test',
    });
    expect((accountInputs[0]?.resolveServerFeaturesSnapshot as (() => unknown))()).toEqual(
      resolveServerFeaturesSnapshot.mock.results[0]?.value,
    );
    expect(resolveServerFeaturesSnapshot).toHaveBeenCalledTimes(2);
    expect(followInputs[0]).toMatchObject({
      token: credentials.token,
      prepareSourceKeyAfterSet: expect.any(Function),
    });
    expect(accountInputs[0]?.serverId).toEqual(followInputs[0]?.serverId);
    expect(accountInputs[0]?.serverHttpBaseUrl).toEqual(followInputs[0]?.serverHttpBaseUrl);
    expect(captured.params).toMatchObject({ serverIdentityId: 'stable-home-identity' });
    expect(captured.params?.resolveServerFeaturesSnapshot).toBeTypeOf('function');
    expect(accountInputs[0]).toMatchObject({ serverIdentityId: 'stable-home-identity' });
    expect(followInputs[0]).toMatchObject({ serverIdentityId: 'stable-home-identity' });
    expect(discussionInputs[0]).toMatchObject({
      credentials,
      serverIdentityId: 'stable-home-identity',
    });
    expect(captured.overrides).toMatchObject({
      machinePoolAction,
      homeDomainAction,
      sessionFollowGet,
      sessionDiscussionAction,
    });
  });

  it('keeps restricted runtime credentials Session-scoped and omits Account-wide Action owners', async () => {
    const captured: { params?: Record<string, unknown>; overrides?: Record<string, unknown>; enabled?: (id: string) => boolean } = {};
    const accountOwner = vi.fn(() => ({}));
    const followOwner = vi.fn(() => ({}));
    const discussionOwner = vi.fn(() => ({}));
    const sessionList = vi.fn();
    vi.doMock('@/api/accountServerActionDeps', () => ({ createAccountServerActionDeps: accountOwner }));
    vi.doMock('@/api/sessionFollowActionDeps', () => ({ createSessionFollowActionDeps: followOwner }));
    vi.doMock('@/session/discussions/sessionDiscussionActionDeps', () => ({ createSessionDiscussionActionDeps: discussionOwner }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>, overrides: Record<string, unknown>) => {
        captured.params = params;
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: {} })) } };
      },
    }));
    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: unknown, params: { deps: { isActionEnabled: (id: string) => boolean } }) => {
        captured.enabled = params.deps.isActionEnabled;
        return { toolNames: [] };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const sessionCredentials = { token: 'restricted-session-token', encryption: null } as const;
    createHappierMcpServer({
      sessionId: 'restricted-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any, {
      sessionCredentials,
      credentials: null,
      authorityScope: 'session',
      sessionList,
    });

    expect(accountOwner).not.toHaveBeenCalled();
    expect(followOwner).not.toHaveBeenCalled();
    // Discussions are Session-placed: the Session transport credentials reach
    // them, never Account authority (the real read/post path is proven below).
    expect(discussionOwner).toHaveBeenCalledWith(expect.objectContaining({ credentials: sessionCredentials }));
    expect(captured.params).toMatchObject({ token: sessionCredentials.token });
    expect(captured.params).not.toHaveProperty('credentials');
    expect(captured.overrides?.sessionList).toBe(sessionList);
    expect(captured.enabled?.('session.title.set')).toBe(true);
    expect(captured.enabled?.('account.apiTokens.list')).toBe(false);
    expect(captured.enabled?.('machines.list')).toBe(false);
  });

  it('opens a Session-scoped runtime\'s own E2EE Board and Discussions with its Session material and no Account credentials', async () => {
    const { default: fastify } = await import('fastify');
    const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
    const { FeaturesResponseSchema, projectSessionAccessCapabilitiesV1 } = await import('@happier-dev/protocol');
    const { sealSessionStoredContent } = await import('@/session/transport/encryption/sessionStoredContentCodec');
    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    // The only boundary replaced is the Home's HTTP transport.
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://runner-home.test' });
    const sessionKey = new Uint8Array(32).fill(41);
    const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' as const } };
    const rawSession = (id: string) => ({
      id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'e2ee', metadata: 'opaque', metadataVersion: 1, dataEncryptionKey: null,
      agentState: null, agentStateVersion: 0,
      effectiveAccess: {
        v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
      },
      responsibleAccountId: null, responsibleAccount: null,
    });
    const layout = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] };
    app.get('/v2/sessions/:sessionId', async (request) => ({
      session: rawSession((request.params as { sessionId: string }).sessionId),
    }));
    app.get('/v2/sessions/:sessionId/system-records/record', async () => ({
      record: {
        id: 'layout.v1:layout',
        address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
        content: sealSessionStoredContent({ ...crypto, payload: layout }),
        revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    }));
    app.get('/v2/sessions/:sessionId/system-records', async () => ({ records: [], nextCursor: null, hasNext: false }));
    app.get('/v2/sessions/:sessionId/discussions', async (request) => ({
      discussions: [{
        id: 'discussion-1',
        sessionId: (request.params as { sessionId: string }).sessionId,
        creationLocalId: 'creation-1',
        titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Runner notes' } }),
        latestMessage: {
          id: 'message-1',
          localId: 'message-1',
          seq: 1,
          authorAccountId: 'account-1',
          accountActor: { v: 1, accountId: 'account-1', profile: null },
          producerV1: null,
          createdAt: 1,
        },
        messageSeq: 1,
        lastReadSeq: 1,
        unreadCount: 0,
        unreadMentionCount: 0,
        recentAuthorAccountIds: ['account-1'],
        archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true },
      }],
      nextCursor: null,
    }));

    const runtime = createHappierMcpServer({
      sessionId: 'runner-session',
      getServerBinding: () => ({ serverId: 'runner-home', serverUrl: 'http://runner-home.test' }),
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      // The live Session client already holds this Session's key.
      getStoredContentEncryptionContext: () => crypto,
      getServerFeaturesSnapshot: () => ({
        status: 'ready' as const,
        provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            // Conversations depend on Session sharing.
            sessions: { enabled: true, board: { enabled: true }, conversations: { enabled: true } },
            sharing: { session: { enabled: true } },
          },
          capabilities: {},
        }),
      }),
    } as any, {
      sessionCredentials: { token: 'runner-session-token', encryption: null },
      credentials: null,
      authorityScope: 'session',
    });

    try {
      const board = await runtime.executeTool({ toolName: 'session_board_get', args: {} });
      expect(JSON.stringify(board)).toContain('"title":"Overview"');
      expect(JSON.stringify(board)).not.toContain('not_authenticated');

      // Discussions are discoverable-only for Agents, so they run through the
      // canonical action_execute tool.
      const discussions = await runtime.executeTool({
        toolName: 'action_execute',
        args: { actionId: 'session.discussion.list', input: {} },
      });
      expect(JSON.stringify(discussions)).toContain('Runner notes');

      // The material answers only for the bound Session: another E2EE Session
      // stays closed instead of borrowing it or degrading to Plain.
      const foreign = await runtime.executeTool({
        toolName: 'session_board_get',
        args: { sessionId: 'other-session' },
      });
      expect(JSON.stringify(foreign)).not.toContain('"title":"Overview"');
    } finally {
      restore();
      await app.close();
    }
  });

  it('returns toolNames aligned with current MCP action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient);
    expect(toolNames).not.toContain('review_start');
    expect(toolNames).not.toContain('subagents_plan_start');
    expect(toolNames).toContain('action_spec_search');
  });

  it('advertises server-backed Session Actions only when the exact Home enables them and the runtime is authenticated', async () => {
    const capturedEnablement: Array<(id: string) => boolean> = [];

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: unknown, params: { deps: { isActionEnabled: (id: string) => boolean } }) => {
        capturedEnablement.push(params.deps.isActionEnabled);
        return { toolNames: [] };
      },
    }));

    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const credentials = { token: 'agent-account-token', encryption: null } as const;
    const createClient = (boardEnabled: boolean, conversationsEnabled: boolean) => ({
      sessionId: `sess_server_backed_action_availability_${boardEnabled}_${conversationsEnabled}`,
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getServerFeaturesSnapshot: () => ({
        status: 'ready' as const,
        provenance: 'authenticated' as const,
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: {
              enabled: true,
              board: { enabled: boardEnabled },
              conversations: { enabled: conversationsEnabled },
            },
          },
          capabilities: {},
        }),
      }),
    });

    createHappierMcpServer(createClient(false, false) as any, { credentials });
    createHappierMcpServer(createClient(true, true) as any, { credentials });
    createHappierMcpServer(createClient(true, true) as any, { credentials: null });

    expect(capturedEnablement).toHaveLength(3);
    expect(capturedEnablement[0]?.('session.board.get')).toBe(false);
    expect(capturedEnablement[1]?.('session.board.get')).toBe(true);
    expect(capturedEnablement[2]?.('session.board.get')).toBe(false);
    expect(capturedEnablement[0]?.('session.discussion.list')).toBe(false);
    expect(capturedEnablement[1]?.('session.discussion.list')).toBe(true);
    expect(capturedEnablement[2]?.('session.discussion.list')).toBe(false);
    expect(capturedEnablement[0]?.('session.list')).toBe(true);
  });

  it('uses account action settings for the in-session MCP tool registry when provided', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { enabled: true, disabledSurfaces: ['agent'], disabledPlacements: [] },
      },
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_tool_names_account_settings_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    const { toolNames } = createHappierMcpServer(fakeClient, {
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              toolExposureModes: {
                agent: 'direct',
              },
            },
          },
        },
      },
    } as any);

    expect(toolNames).toContain('session_list');
  });

  it('reads current account action settings when registered session-agent MCP tools run', async () => {
    const handlers: Record<string, (args: any) => Promise<any>> = {};

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class FakeMcpServer {
        registerResource() {}
        registerTool(name: string, _meta: any, handler: any) {
          handlers[name] = handler;
        }
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    let currentAccountSettings: any = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'review.start': {
            disabledSurfaces: ['agent'],
          },
        },
      },
    };

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_settings_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any, {
      getAccountSettings: () => currentAccountSettings,
    } as any);

    const handler = handlers.action_spec_get;
    expect(typeof handler).toBe('function');

    const disabledResult = await handler({ id: 'review.start' });
    expect(disabledResult.isError).toBe(true);
    expect(JSON.parse(disabledResult.content[0].text)).toMatchObject({
      errorCode: 'action_disabled',
      details: {
        actionId: 'review.start',
        surface: 'agent',
        reason: 'disabled_by_settings',
      },
    });

    currentAccountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {},
      },
    };

    const enabledResult = await handler({ id: 'review.start' });
    expect(enabledResult.isError).toBe(false);
    expect(JSON.parse(enabledResult.content[0].text)).toMatchObject({
      actionSpec: {
        id: 'review.start',
      },
    });

    const planResult = await handler({ id: 'subagents.plan.start' });
    expect(planResult.isError).toBe(false);
    expect(JSON.parse(planResult.content[0].text)).toMatchObject({
      actionSpec: {
        kindVersion: 1,
        inputSchema: {
          type: 'object',
          properties: {
            backendTargetKeys: {
              type: 'array',
              minItems: 1,
              items: {
                anyOf: expect.arrayContaining([
                  expect.objectContaining({
                    type: 'string',
                    pattern: '^(agent|acpBackend):.+$',
                  }),
                ]),
              },
            },
            permissionMode: {
              description: expect.any(String),
            },
          },
        },
      },
    });

    const spawnResult = await handler({ id: 'session.spawn_new' });
    expect(spawnResult.isError).toBe(false);
    expect(JSON.parse(spawnResult.content[0].text)).toMatchObject({
      actionSpec: {
        inputSchema: {
          properties: {
            executionTarget: {
              properties: {
                serverId: { minLength: 1, maxLength: 191 },
              },
            },
            organizationPlacement: {
              properties: {
                tagIds: { type: 'array', maxItems: 500 },
              },
            },
          },
        },
      },
    });
  });

  it('uses account action settings for in-session MCP approval policy when provided', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { disabledSurfaces: [] },
      },
    });
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_approval_policy_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any, {
      accountSettings: {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['agent'],
            },
          },
        },
      },
    } as any);

    expect(captured.deps).toBeDefined();
    expect(captured.deps.isActionApprovalRequired('session.list', { surface: 'agent' })).toBe(true);
  });

  it('reads current session-agent spawn policy when action-backed tools execute', async () => {
    const executorExecute = vi.fn(async (actionId: string, input: unknown, ctx: unknown) => ({
      ok: true,
      result: { actionId, input, ctx },
    }));
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: executorExecute,
        },
      }),
    }));

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const firstPolicy = { allowedBackendTargetKeys: ['agent:codex'] };
    const secondPolicy = { allowedBackendTargetKeys: ['agent:claude'] };
    let currentAccountSettings: any = {
      sessionAgentSpawnPolicyV1: firstPolicy,
    };

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_spawn_policy_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any, {
      getAccountSettings: () => currentAccountSettings,
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { prompt: 'Spawn a helper' },
    }, 'sess_mcp_live_spawn_policy_1');
    expect(executorExecute).toHaveBeenLastCalledWith(
      'session.spawn_new',
      { prompt: 'Spawn a helper' },
      expect.objectContaining({
        sessionAgentSpawnPolicyV1: firstPolicy,
      }),
    );

    currentAccountSettings = {
      sessionAgentSpawnPolicyV1: secondPolicy,
    };

    await captured.deps.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { prompt: 'Spawn another helper' },
    }, 'sess_mcp_live_spawn_policy_1');
    expect(executorExecute).toHaveBeenLastCalledWith(
      'session.spawn_new',
      { prompt: 'Spawn another helper' },
      expect.objectContaining({
        sessionAgentSpawnPolicyV1: secondPolicy,
      }),
    );
  });

  it('executes native Agent tool calls through the live Session authority and policy owner', async () => {
    const executorExecute = vi.fn(async (actionId: string, input: unknown, ctx: unknown) => ({
      ok: true,
      result: { actionId, input, ctx },
    }));

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: executorExecute,
        },
      }),
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'read_only',
    } as const;
    const spawnPolicy = { allowedBackendTargetKeys: ['agent:codex'] };
    const runtime = createHappierMcpServer({
      sessionId: 'sess_native_agent_tool_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getPermissionMode: () => 'yolo',
      getActiveTurnPermissionWitness: () => ({
        turnId: 'turn_native_agent_tool_1',
        causalPermissionAuthority,
      }),
    } as any, {
      accountSettings: {
        sessionAgentSpawnPolicyV1: spawnPolicy,
      },
      requiredDirectActionIds: ['session.transcript.get'],
      sessionInputVia: 'action',
    } as any);

    await runtime.executeTool({
      toolName: 'action_execute',
      args: {
        actionId: 'session.spawn_new',
        input: { prompt: 'Spawn a helper' },
      },
      toolCallId: 'native_tool_call_1',
    });

    expect(executorExecute).toHaveBeenCalledWith(
      'session.spawn_new',
      { prompt: 'Spawn a helper' },
      expect.objectContaining({
        defaultSessionId: 'sess_native_agent_tool_1',
        surface: 'agent',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority,
        sessionInputSource: {
          sourceSessionId: 'sess_native_agent_tool_1',
          sourceTurnId: 'turn_native_agent_tool_1',
          via: 'action',
        },
        sessionAgentSpawnPolicyV1: spawnPolicy,
        actionRequestId: 'native_tool_call_1',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'sess_native_agent_tool_1',
          toolCallId: 'native_tool_call_1',
          toolName: 'action_execute',
        },
      }),
    );

    await runtime.executeTool({
      toolName: 'session_transcript_get',
      args: { limit: 10 },
      toolCallId: 'native_tool_call_2',
    });
    expect(executorExecute).toHaveBeenCalledWith(
      'session.transcript.get',
      expect.objectContaining({ sessionId: 'sess_native_agent_tool_1', limit: 10 }),
      expect.objectContaining({
        defaultSessionId: 'sess_native_agent_tool_1',
        surface: 'agent',
        actionRequestId: 'native_tool_call_2',
      }),
    );
  });

  it('binds Agent Discussion posts to the live Session publisher carrier', async () => {
    const postAgentDiscussionMessage = vi.fn(async () => ({
      ok: false as const,
      v: 1 as const,
      error: 'session_discussion_post_denied' as const,
    }));
    let capturedTransport: ((request: any, options?: any) => Promise<unknown>) | undefined;

    vi.doMock('@/session/discussions/sessionDiscussionActionDeps', () => ({
      createSessionDiscussionActionDeps: (options: any) => {
        capturedTransport = options.postAgentMessage;
        return { sessionDiscussionAction: vi.fn() };
      },
    }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: { execute: vi.fn() },
      }),
    }));
    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: () => ({ toolNames: [] }),
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer({
      sessionId: 'session-1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      postAgentDiscussionMessage,
    } as any, {
      credentials: { token: 'token-1' } as any,
    });

    expect(capturedTransport).toBeTypeOf('function');
    const signal = new AbortController().signal;
    await capturedTransport!({
      v: 1,
      sessionId: 'session-1',
      discussionId: 'discussion-1',
      request: {
        localId: 'message-1',
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Done' }] } },
        mentionedAccountIds: [],
      },
      runId: 'run-1',
      toolCallId: 'tool-1',
    }, { signal });

    expect(postAgentDiscussionMessage).toHaveBeenCalledWith({
      discussionId: 'discussion-1',
      request: expect.objectContaining({ localId: 'message-1' }),
      runId: 'run-1',
      toolCallId: 'tool-1',
    }, { signal });
  }, 60_000);

  it('uses the live session permission mode for session-agent action execution instead of stale metadata', async () => {
    const executorExecute = vi.fn(async (actionId: string, input: unknown, ctx: unknown) => ({
      ok: true,
      result: { actionId, input, ctx },
    }));
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: executorExecute,
        },
      }),
    }));

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_permission_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 1 }),
      getPermissionMode: () => 'yolo',
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { permissionMode: 'bypassPermissions' },
    }, 'sess_mcp_live_permission_1');

    expect(executorExecute).toHaveBeenLastCalledWith(
      'session.spawn_new',
      { permissionMode: 'bypassPermissions' },
      expect.objectContaining({
        callerPermissionMode: 'yolo',
      }),
    );
  });

  it('passes the live session backend target into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_backend_target_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({ path: '/repo/current' }),
      getBackendTarget: () => ({
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.getCurrentSessionBackendTarget()).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      sourceKind: 'configured',
      configuredBackendId: 'review-bot',
    });
  });

  it('suppresses retained memory hits outside the session bound to an unauthenticated MCP client', async () => {
    const captured: { overrides?: any } = {};
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (_params: unknown, overrides: any) => {
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer({
      sessionId: 'bound-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: {
        invokeLocal: async () => ({
          v: 1,
          ok: true,
          hits: [
            {
              sessionId: 'bound-session',
              seqFrom: 1,
              seqTo: 1,
              createdAtFromMs: 1,
              createdAtToMs: 1,
              summary: 'readable',
              score: 1,
            },
            {
              sessionId: 'revoked-session',
              seqFrom: 1,
              seqTo: 1,
              createdAtFromMs: 1,
              createdAtToMs: 1,
              summary: 'retained after revocation',
              score: 0.5,
            },
          ],
        }),
      },
      updateMetadata: () => {},
    } as any, { credentials: null } as any);

    await expect(captured.overrides.daemonMemorySearch({
      query: { v: 1, query: 'retained', scope: { type: 'global' }, mode: 'hints' },
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      hits: [expect.objectContaining({ sessionId: 'bound-session' })],
    }));
  });

  it('rejects an unauthenticated memory window outside the MCP-bound Session before daemon RPC', async () => {
    const captured: { overrides?: any } = {};
    const invokeLocal = vi.fn(async () => ({ v: 1, snippets: [], citations: [] }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (_params: unknown, overrides: any) => {
        captured.overrides = overrides;
        return { executor: { execute: vi.fn(async () => ({ ok: true, result: { ok: true } })) } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer({
      sessionId: 'bound-session',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal },
      updateMetadata: () => {},
    } as any, { credentials: null } as any);

    await expect(captured.overrides.daemonMemoryGetWindow({
      sessionId: 'other-session',
      seqFrom: 1,
      seqTo: 2,
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('passes live session location into action executor deps', async () => {
    const captured: { params?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: any) => {
        captured.params = params;
        return {
          executor: {
            execute: vi.fn(async () => ({ ok: true, result: { ok: true } })),
          },
        };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_live_location_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
      getMetadataSnapshot: () => ({
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      }),
      getCurrentSessionLocation: () => ({
        path: '/repo/current',
        host: 'leeroy-mbp',
        machineId: 'machine-1',
      }),
    } as any);

    expect(captured.params).toBeDefined();
    expect(captured.params.rawSession).toEqual({
      metadata: {
        permissionMode: 'bypassPermissions',
        permissionModeUpdatedAt: 10,
      },
      path: '/repo/current',
      host: 'leeroy-mbp',
      machineId: 'machine-1',
    });
  });

  it('forwards execution.run.list request payloads through the shared action executor deps', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async (_method: string, params: unknown) => params);
    createHappierMcpServer({
      sessionId: 'sess_mcp_payload_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal },
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executionRunList('sess_mcp_payload_1', { status: 'running' });
    expect(invokeLocal).toHaveBeenCalledWith('execution.run.list', { status: 'running' });
  });

  it('prefers the session execution-run service when the client provides one', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async (_method: string, params: unknown) => params);
    const list = vi.fn(async () => ({ ok: true, data: { runs: [{ runId: 'run_1' }] } }));
    createHappierMcpServer({
      sessionId: 'sess_mcp_payload_2',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal },
      updateMetadata: () => {},
      executionRuns: {
        start: vi.fn(),
        list,
        get: vi.fn(),
        send: vi.fn(),
        stop: vi.fn(),
        action: vi.fn(),
      },
    } as any);

    expect(captured.deps).toBeDefined();
    await captured.deps.executionRunList('sess_mcp_payload_2', { status: 'running' });
    expect(list).toHaveBeenCalledWith({ status: 'running' });
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('treats raw local execution-run rpc error payloads as errors in the fallback bridge', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async () => ({
      error: 'RPC method not available',
      errorCode: 'RPC_METHOD_NOT_AVAILABLE',
    }));
    createHappierMcpServer({
      sessionId: 'sess_mcp_payload_3',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal },
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    await expect(captured.deps.executionRunList('sess_mcp_payload_3', { status: 'running' })).resolves.toEqual({
      ok: false,
      code: 'RPC_METHOD_NOT_AVAILABLE',
      message: 'RPC method not available',
    });
  });

  it('forwards prompt_registry.install through the shared action executor deps', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const invokeLocal = vi.fn(async (_method: string, params: unknown) => ({
      ok: true,
      digest: 'sha256:deadbeef',
      request: params,
    }));
    createHappierMcpServer({
      sessionId: 'sess_mcp_prompt_registry_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal },
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    const res = await captured.deps.promptRegistryInstall({
      machineId: 'machine_1',
      sourceId: 'source_1',
      itemId: 'item_1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'codex.prompts',
        scope: 'user',
        targetName: 'example-skill',
        installMode: 'copy',
      },
    });
    expect(invokeLocal).toHaveBeenCalledWith('daemon.promptRegistry.install', {
      sourceId: 'source_1',
      itemId: 'item_1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'codex.prompts',
        scope: 'user',
        targetName: 'example-skill',
        installMode: 'copy',
      },
    });
    expect(res).toMatchObject({ ok: true, digest: 'sha256:deadbeef' });
  });

  it('routes session control deps through the shared CLI action deps (not unsupported stubs)', async () => {
    const captured: { deps?: any } = {};

    vi.doMock('@happier-dev/protocol', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
      return {
        ...actual,
        createActionExecutor: (deps: any) => {
          captured.deps = deps;
          return {} as any;
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    createHappierMcpServer({
      sessionId: 'sess_mcp_session_control_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any);

    expect(captured.deps).toBeDefined();
    await expect(
      captured.deps.sessionList({ limit: 1, cursor: null, activeOnly: false, archivedOnly: false, includeSystem: false, resumableOnly: false }),
    ).resolves.toEqual({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
  });

  it('dispatches registered tools using the agent surface (internal MCP)', async () => {
    const captured: { surface?: string } = {};
    const handlers: Record<string, (args: any) => Promise<any>> = {};

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class FakeMcpServer {
        registerResource() {}
        registerTool(name: string, _meta: any, handler: any) {
          handlers[name] = handler;
        }
      },
    }));

    vi.doMock('@/agent/tools/happierTools/dispatchBuiltInHappierTool', () => ({
      dispatchBuiltInHappierTool: async (params: any) => {
        captured.surface = params.surface;
        return { ok: true, result: { ok: true } };
      },
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');

    const fakeClient = {
      sessionId: 'sess_mcp_surface_1',
      getServerBinding: getTestServerBinding,
      rpcHandlerManager: { invokeLocal: async () => ({}) },
      updateMetadata: () => {},
    } as any;

    createHappierMcpServer(fakeClient);

    expect(typeof handlers.change_title).toBe('function');
    await handlers.change_title({ title: 'Hello' });
    expect(captured.surface).toBe('agent');
  });

  it('routes change_title through the action executor (so approvals/enablement apply)', async () => {
    const execute = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: () => ({ executor: { execute } }),
      };
    });

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_change_title_1',
        getServerBinding: getTestServerBinding,
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        updateMetadata: () => {},
      } as any,
      { credentials: null },
    );

    expect(captured.deps).toBeDefined();
    await captured.deps.changeTitle('sess_change_title_1', 'New title');
    expect(execute).toHaveBeenCalledWith(
      'session.title.set',
      { sessionId: 'sess_change_title_1', title: 'New title' },
      { surface: 'agent', defaultSessionId: 'sess_change_title_1' },
    );
  });

  it('does not perform a redundant metadata write after change_title commits', async () => {
    const execute = vi.fn(async () => ({ ok: true, result: { ok: true } }));
    const updateMetadata = vi.fn(() => {
      throw new Error('local metadata sync failed');
    });
    const captured: { deps?: any } = {};

    vi.doMock('@/session/actions/createCliActionExecutorHarness', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/actions/createCliActionExecutorHarness')>();
      return {
        ...actual,
        createCliActionExecutorHarness: () => ({ executor: { execute } }),
      };
    });

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_change_title_refresh_1',
        getServerBinding: getTestServerBinding,
        rpcHandlerManager: { invokeLocal: async () => ({}) },
        updateMetadata,
      } as any,
      { credentials: null },
    );

    expect(captured.deps).toBeDefined();
    await expect(captured.deps.changeTitle('sess_change_title_refresh_1', 'New title')).resolves.toEqual({
      success: true,
      title: 'New title',
    });
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('routes direct-exposed execution_run_start through the shared action executor path', async () => {
    const activeTurnAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'default',
    } as const;
    const invokeLocal = vi.fn(async (method: string, params: unknown) => {
      if (method === 'execution.run.start' || method === 'execution.run.send') {
        return {
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'side_1',
          request: params,
        };
      }
      return {};
    });
    const captured: { deps?: any } = {};
    const executorExecute = vi.fn(async (actionId: string, input: unknown, ctx: unknown) => ({
      ok: true,
      result: { actionId, input, ctx },
    }));

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/mcp/server/registerHappierMcpBuiltInTools')>();
      return {
        ...actual,
        registerHappierMcpBuiltInTools: (_server: any, params: any) => {
          captured.deps = params.deps;
          return { toolNames: [] };
        },
      };
    });
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: executorExecute,
        },
      }),
    }));

    const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
    createHappierMcpServer(
      {
        sessionId: 'sess_execution_run_start_1',
        getServerBinding: getTestServerBinding,
        rpcHandlerManager: { invokeLocal },
        updateMetadata: () => {},
        // The mutable Session mode has widened since this turn was admitted.
        getPermissionMode: () => 'yolo',
        getActiveTurnPermissionWitness: () => ({
          turnId: 'turn-active',
          causalPermissionAuthority: activeTurnAuthority,
        }),
      } as any,
      {
        credentials: null,
        accountSettings: {
          actionsSettingsV1: {
            v: 1,
            actions: {
              'execution.run.start': {
                toolExposureModes: {
                  agent: 'direct',
                },
              },
            },
          },
        },
      } as any,
    );

    expect(captured.deps).toBeDefined();
    await captured.deps.executeActionByToolName('execution_run_start', {
      intent: 'plan',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(executorExecute).toHaveBeenCalledWith('execution.run.start', expect.objectContaining({
      intent: 'plan',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      instructions: 'Plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }), expect.objectContaining({
      surface: 'agent',
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: activeTurnAuthority,
    }));
    expect(invokeLocal).not.toHaveBeenCalled();
  });
});
