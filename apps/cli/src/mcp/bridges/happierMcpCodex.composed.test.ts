import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildCodexAppServerConfigOverrides } from '@happier-dev/plugins-codex/agent/runtime/appServer/config/overrides';
import { accountSettingsParse, McpServersSettingsV1Schema, projectMcpServerMaterializationV1, resolveSessionCapabilitiesV1 } from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { mergeWithBuiltInHappierMcpServer } from '@/mcp/servers/mergeWithBuiltInHappierMcpServer';
import { projectStoredMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { SESSION_MCP_CONTEXT_FILE_ENV } from '@/mcp/runtime/sessionMcpLocalTransport';
import { HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI } from '@/mcp/resources/registerHappierMcpResources';

const originalSourceEntrypointFlag = process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
const originalToolIdleTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
const daemonCatalogBoundary = vi.hoisted(() => ({
  read: vi.fn(async () => ({ kind: 'available' as const, plugins: [], tools: [] })),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  // Daemon IPC is the external boundary. No plugin Action matches these
  // built-in reads; retain their real host executor instead of requiring a daemon.
  return { ...actual, readDaemonPluginCatalog: daemonCatalogBoundary.read,
    requestDaemonPluginActionExecution: async () => ({ matched: false }) };
});

function expectCodexHappierBridgeWiring(overrides: readonly string[]): void {
  expect(overrides).toEqual(expect.arrayContaining([
    'mcp_servers.happier.enabled=true',
    'mcp_servers.happier.required=true',
    'mcp_servers.happier.startup_timeout_sec=60',
    'mcp_servers.happier.tools.action_spec_search.approval_mode="approve"',
  ]));
  expect(overrides.some((override) => override.startsWith('mcp_servers.happier.command='))).toBe(true);
  expect(overrides.some((override) => override.startsWith('mcp_servers.happier.args='))).toBe(true);
}

describe('Happier MCP → Codex composed wiring', () => {
  afterEach(() => {
    if (originalToolIdleTimeout === undefined) {
      delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
    } else {
      process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = originalToolIdleTimeout;
    }
    if (originalSourceEntrypointFlag === undefined) {
      delete process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
    } else {
      process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = originalSourceEntrypointFlag;
    }
  });

  it.runIf(process.platform !== 'win32')('refuses Session-local resource discovery and reads without its context', async () => {
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    const sessionId = 'session-local-resource-auth';
    const bridge = await createHappierMcpBridge({ sessionId,
      getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => ({}),
    }, { accountSettings: accountSettingsParse({}) });
    const config = bridge.mcpServers.happier;
    const env = { ...config.env };
    delete env[SESSION_MCP_CONTEXT_FILE_ENV];
    const client = new Client({ name: 'resource-auth-test', version: '1' }, { capabilities: {} });
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args: [...(config.args ?? [])], env }));
      await expect(client.listResources()).rejects.toThrow();
      await expect(client.readResource({ uri: HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI })).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
      await bridge.happierMcpServer.stop();
    }
  // This starts the same source bridge as the catalog cases below, whose
  // advertised Codex bridge startup contract allows 60 seconds.
  }, 60_000);

  // Opt-in because this exercises an installed vendor executable, without
  // credentials or a model request. Ordinary turn execution is composed in
  // createHappierMcpServer.test.ts; this case observes the vendor registry itself.
  it.runIf(process.env.HAPPIER_CODEX_NATIVE_MCP_TEST === '1')('registers action_execute in the real native app-server tool registry with invalid managed siblings excluded', async () => {
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    const home = await mkdtemp(join(tmpdir(), 'c242-native-mcp-'));
    const sessionId = 'c242-native-registry';
    const bridge = await createHappierMcpBridge({ sessionId,
      getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {}, getMetadataSnapshot: () => ({}),
    }, { accountSettings: accountSettingsParse({}) });
    const managed = McpServersSettingsV1Schema.parse({ v: 1, strictMode: false, servers: [
      { id: 'missing-fixture', name: 'missing_fixture', transport: 'stdio', stdio: { command: 'unused-fixture', args: [] },
        env: { FIXTURE_TOKEN: { t: 'literal', v: '${C242_UNRESOLVED_FIXTURE}' } }, createdAt: 1, updatedAt: 1 },
      { id: 'invalid-fixture', name: 'invalid_fixture', transport: 'http',
        remote: { url: 'https://fixture.invalid/mcp', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 },
    ], bindings: ['missing-fixture', 'invalid-fixture'].map(serverId => ({ id: `binding-${serverId}`, serverId,
      enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 })) });
    // A malformed persisted definition is rejected by the catalog reader before
    // selection; operationally invalid definitions produce materializer issues.
    const stored = projectStoredMcpServerCatalogV1({ v: 1,
      servers: [...managed.servers, { id: 'malformed-fixture', name: 'malformed_fixture', transport: 'stdio',
        env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [...managed.bindings, { id: 'binding-malformed', serverId: 'malformed-fixture',
        enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }],
    });
    expect(stored).toMatchObject({ status: 'partial', diagnostics: expect.arrayContaining([
      { path: 'servers[2]', reason: 'invalid-stored-content' },
    ]) });
    if (stored.status === 'unavailable') throw new Error('Independent valid catalog entries must remain available');
    const materialized = await materializeMcpServerConfigRecord({
      resolved: projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
        context: { machineId: 'fixture-machine', directory: home, machinePlatform: null, projectKey: null, agentId: 'codex' },
        mcp: { ...stored.catalog, strictMode: false }, skills: null, selection: {}, agentAcceptsUserMcp: true,
      }), home), processEnv: {}, tmpDir: home,
    });
    expect(materialized.warnings).toEqual([
      { serverName: 'missing_fixture', code: 'missing_value_ref', detail: 'env:FIXTURE_TOKEN' },
      { serverName: 'invalid_fixture', code: 'invalid_server', detail: 'mcp_sign_in_required' },
    ]);
    expect(materialized.mcpServers).toEqual({});
    const overrides = buildCodexAppServerConfigOverrides(mergeWithBuiltInHappierMcpServer({
      builtIn: bridge.mcpServers, extra: materialized.mcpServers,
    }));
    const native = spawn(process.env.HAPPIER_CODEX_NATIVE_TEST_BINARY ?? 'codex', ['app-server', ...overrides.flatMap(value => ['-c', value])], {
      cwd: home, env: { PATH: process.env.PATH, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(native, 'exit');
    void exited.catch(() => {}); // The request reports spawn failure; cleanup still owns the bridge.
    const responses = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
    let nextId = 0;
    const lines = createInterface({ input: native.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id === undefined) return;
      const response = responses.get(message.id);
      if (!response) return;
      responses.delete(message.id);
      if (message.error) response.reject(message.error); else response.resolve(message.result);
    });
    native.stderr.on('data', () => {}); // Vendor stderr can contain local configuration; never retain it.
    const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
      const id = ++nextId;
      responses.set(id, { resolve, reject });
      native.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    native.on('error', error => { for (const response of responses.values()) response.reject(error); });
    native.on('exit', code => { for (const response of responses.values()) response.reject(new Error(`Native app-server exited ${code}`)); });
    try {
      const initialized = await request('initialize', { clientInfo: { name: 'c242_mcp_test', version: '1' }, capabilities: { experimentalApi: true } });
      native.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
      const status = await request('mcpServerStatus/list', {});
      expect(initialized).toMatchObject({ userAgent: expect.any(String) });
      expect(status).toMatchObject({ data: [expect.objectContaining({ name: 'happier', toolsError: null,
        tools: expect.objectContaining({ action_execute: expect.objectContaining({ name: 'action_execute' }) }) })] });
    } finally {
      native.stdin.end(); await exited.catch(() => {}); lines.close();
      bridge.happierMcpServer.stop(); materialized.cleanup(); await rm(home, { recursive: true });
    }
  }, 60_000);

  it.each(['default', 'direct'] as const)('exposes the real Action catalog through Codex with %s exposure', async (exposure) => {
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1';
    process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '420000';
    const sessionId = 'sess_mcp_codex_composed_1';
    let admitted = false;
    const session: HappyMcpSessionClient = {
      sessionId,
      getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
      rpcHandlerManager: new RpcHandlerManager({
        scopePrefix: sessionId,
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      }),
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({ work: { memoryEnabled: true } }),
      // Host admission is the input boundary to this MCP transport composition.
      // Listing tools is turn-neutral; invoking them needs the host's live facts.
      getWorkDepth: () => 0,
      getHostTurnWorkDepth: turnId => admitted && turnId === 'catalog-turn' ? 0 : undefined,
      getActiveTurnPermissionWitness: () => admitted ? { turnId: 'catalog-turn',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } } : null,
    };
    const bridge = await createHappierMcpBridge(session, {
      accountSettings: accountSettingsParse(exposure === 'default' ? {} : {
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              toolExposureModes: { agent: 'direct' },
            },
          },
        },
      }),
    });
    const config = bridge.mcpServers.happier;
    const overrides = buildCodexAppServerConfigOverrides(bridge.mcpServers);
    expectCodexHappierBridgeWiring(overrides);

    // Sensitivity: removing the real server binding must invalidate this seam proof.
    expect(() => expectCodexHappierBridgeWiring(buildCodexAppServerConfigOverrides({}))).toThrow();

    const client = new Client({ name: 'happier-codex-composed-test', version: '1.0.0' }, { capabilities: {} });
    try {
      expect(config.env).toMatchObject({ AGENT_BROWSER_IDLE_TIMEOUT_MS: '420000' });
      expect(overrides.find(override => override.startsWith('mcp_servers.happier.env=')))
        .toContain('AGENT_BROWSER_IDLE_TIMEOUT_MS="420000"');
      await client.connect(new StdioClientTransport({
        command: config.command,
        args: [...(config.args ?? [])],
        env: config.env ? { ...config.env } : undefined,
      }));
      const catalog = await client.listTools();
      const names = catalog.tools.map((tool) => tool.name);
      expect((await client.listResources()).resources.map(resource => resource.uri))
        .toContain(HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI);
      const resource = await client.readResource({ uri: HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI });
      expect(resource.contents).toEqual([expect.objectContaining({
        uri: HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI, mimeType: 'application/json', text: expect.any(String),
      })]);

      expect(names).toEqual(expect.arrayContaining([
        'action_spec_search',
        'action_spec_get',
        'action_execute',
      ]));
      expect(names.includes('session_list')).toBe(exposure === 'direct');
      expect(names).not.toContain('session_status_get');
      const refused = CallToolResultSchema.parse(await client.callTool({
        name: 'action_spec_get', arguments: { id: 'session.list' },
      }));
      expect(refused).toMatchObject({ isError: true, content: [
        { type: 'text', text: JSON.stringify({ errorCode: 'target_unavailable', error: 'target_unavailable' }) },
      ] });
      admitted = true;
      // Discoverable-only does not mean absent: use the real MCP transport,
      // catalog, policy and handlers to obtain both operational read schemas.
      for (const id of ['session.list', 'session.status.get']) {
        const result = CallToolResultSchema.parse(await client.callTool({
          name: 'action_spec_get', arguments: { id },
        }));
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const text = result.content.find(item => item.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Expected a discovery result');
        expect(JSON.parse(text.text)).toMatchObject({ actionSpec: { id, inputSchema: expect.any(Object) } });
      }
      expect(names.every((name) => /^[A-Za-z0-9_.-]+$/u.test(name))).toBe(true);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(names);
    } finally {
      await client.close().catch(() => undefined);
      bridge.happierMcpServer.stop();
    }
  // Codex's bridge startup contract above allows 60s; source-entrypoint startup
  // on an admitted, busy worker must not be cut off by the former 30s test timer.
  }, 60_000);
});
