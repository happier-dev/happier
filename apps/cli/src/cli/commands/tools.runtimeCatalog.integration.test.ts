import axios from 'axios';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { handleToolsCommand } from './tools';
import { captureConsoleLogAndMuteStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { listBuiltInHappierTools as projectBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { bootstrapAccountSettingsContext as bootstrapSettings, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { withCliApiToken } from '@/auth/cliApiToken';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { AccountApiTokenSelfV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createServer } from 'node:http';

type BoundaryTools = { tools: Array<{ name: string; description?: string; inputSchema: { type: 'object' } }> };
let listToolsAtBoundary: () => Promise<BoundaryTools>;
let connectAtBoundary: (transport: { command: string }) => Promise<void>;
let callToolAtBoundary: () => Promise<unknown>;
let outwardCalls: string[];
let mcpCatalog: McpServerCatalogV1;
let exactHomeOrigin = 'https://home.example.test';
let openToolConnections = 0;

// Genuine process/SDK boundaries only: the command, row selector, materializer,
// custom resolver, and custom-list orchestration remain their actual owners.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private connected = false;
    async connect(transport: { command: string }) { await connectAtBoundary(transport); this.connected = true; openToolConnections++; }
    async listTools() { return await listToolsAtBoundary(); }
    async callTool(request: { name: string }) {
      outwardCalls.push(request.name);
      return await callToolAtBoundary();
    }
    async close() { if (this.connected) { this.connected = false; openToolConnections--; } }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    stderr = null;
    command: string;
    constructor(config: { command: string }) { this.command = config.command; }
  },
}));
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readSettings: async () => ({ schemaVersion: 6, onboardingCompleted: true, machineId: 'machine-1' }),
  // A live daemon owns registration; the actual initializer follows its normal
  // same-process PID check instead of replacing the initializer or ApiClient.
  readDaemonState: async () => ({ pid: process.pid, httpPort: 1, startedAt: 1,
    startedWithCliVersion: '0.0.0-test', controlToken: 'daemon-control-test' }),
}));

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/api/client/serverHttpBaseUrl', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/serverHttpBaseUrl')>(),
  resolveServerHttpBaseUrl: () => exactHomeOrigin,
}));

function bootstrapToolSettings(raw: Readonly<Record<string, unknown>> = {}): typeof bootstrapSettings {
  return input => bootstrapSettings({ ...input, honorAccountSettingsModeEnv: false,
    deps: { resolveCachePath: resolveAccountSettingsCachePath, readCache: async () => null, writeCache: async () => undefined,
      fetchFromServer: async () => ({ settingsVersion: 1, settingsContent: { t: 'plain', v: raw } }),
    },
  });
}

beforeEach(() => {
  exactHomeOrigin = 'https://home.example.test';
  openToolConnections = 0;
  resetInMemoryAccountSettingsContextForTests();
  mcpCatalog = { v: 1, servers: [], bindings: [] };
  connectAtBoundary = async () => {};
  callToolAtBoundary = async () => ({ content: [{ type: 'text', text: 'Acknowledged' }], structuredContent: { effect: 'accepted' } });
  outwardCalls = [];
  listToolsAtBoundary = async () => ({ tools: [{ name: 'open_page', description: 'Open a page', inputSchema: { type: 'object' } }] });
  vi.mocked(axios.get).mockReset().mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
    } };
    if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: {
      status: 'present', revision: 3, content: { t: 'plain', v: mcpCatalog },
    } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    throw new Error(`Unexpected HTTP path: ${path}`);
  });
});
afterEach(() => { resetInMemoryAccountSettingsContextForTests(); vi.unstubAllGlobals(); });

function createBaseDeps() {
  return {
    readCredentials: async () => ({
      token: 'token',
      encryption: null,
      credentialProvenance: 'stored_session' as const,
    }),
    initializeBackendApiContext: async () => ({
      api: { getServerFeaturesSnapshot: async () => undefined } as any,
      machineId: 'machine-1',
    }),
    bootstrapAccountSettingsContext: bootstrapToolSettings(),
    resolveCustomHappierToolsContext: async () => ({ mcpServers: {}, warnings: [], cleanup: () => undefined }),
  };
}

function prepareCustomCallCatalog() {
  mcpCatalog = { v: 1, servers: [{ id: 'call-server', name: 'call-source', transport: 'stdio',
    stdio: { command: 'call-fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
    bindings: [{ id: 'call-binding', serverId: 'call-server', enabled: true,
      target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
}

function retireAndReenterToolsAccount() {
  const captured = getActiveAccountSettingsSnapshot();
  if (!captured?.mcpServerCatalog) throw new Error('Expected the real admitted Account capture');
  expect(captured.mcpServerCatalog.status).toBe('ready');
  setActiveAccountSettingsSnapshot({ ...captured, scopeKey: 'retired-tools-account' });
  setActiveAccountSettingsSnapshot({ ...captured });
}

describe('happier tools --json', () => {
  it.each(['owner', 'member'] as const)('qualifies opaque API automation through the actual CLI initializer and Home (%s)', async accountId => {
    const installation = readOrCreateInstallationIdentitySync();
    const credentialId = 'afbc64cb-68d1-4a57-b55d-4096ab268c80';
    const token = `hap_v1_${credentialId}_${'A'.repeat(43)}`;
    const principal = AccountApiTokenSelfV1Schema.parse({ accountId, accountEncryptionMode: 'plain', credentialId,
      parentTokenId: null, expiresAt: null, grant: API_TOKEN_FULL_GRANT_V1, embedConfig: null });
    let selfReads = 0;
    let machineReads = 0;
    let catalogReads = 0;
    mcpCatalog = { v: 1, servers: [{ id: 'api-server', name: 'api-server', transport: 'stdio',
      stdio: { command: 'api-fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'api-binding', serverId: 'api-server', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    const home = createServer((request, response) => {
      request.resume();
      response.setHeader('content-type', 'application/json');
      const path = new URL(request.url ?? '/', 'http://home.test').pathname;
      if (path !== '/v1/features' && request.headers.authorization !== `Bearer ${token}`) {
        response.statusCode = 401;
        response.end('{}');
        return;
      }
      let body: unknown;
      if (path === '/v1/features') body = { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_tools_owner' } } };
      else if (path === '/v1/auth/api-tokens/self') { selfReads++; body = principal; }
      else if (path === '/v1/machines/machine-1') { machineReads++; body = { machine: { id: 'machine-1',
        installationId: installation.installationId, metadata: null, metadataVersion: 0, daemonState: null,
        daemonStateVersion: 0, storageMode: 'plain', access: { custodian: { accountId: 'owner', displayName: 'Owner' },
          role: 'manage', resourceMode: 'plain', accessState: 'ready' } } }; }
      else if (path === '/v1/account/entity-rows/mcp') { catalogReads++; body = {
        status: 'present', revision: 1, content: { t: 'plain', v: mcpCatalog } }; }
      else if (path === '/v1/account/encryption/currentness') body = { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 };
      else { response.statusCode = 404; body = {}; }
      response.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Expected fixture Home');
    exactHomeOrigin = `http://127.0.0.1:${address.port}`;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      const response = await fetch(String(url), { headers: options?.headers as Record<string, string> | undefined });
      return { status: response.status, data: await response.json() };
    });
    const output = captureConsoleLogAndMuteStdout();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withCliApiToken(token, () => handleToolsCommand(['list', '--directory', '/tmp/workspace',
        ...(accountId === 'member' ? ['--json'] : [])], {
        bootstrapAccountSettingsContext: bootstrapToolSettings(),
        listBuiltInHappierTools: projectBuiltInHappierTools,
      }));
      if (accountId === 'owner') {
        expect(output.logs.join('\n').includes('api-server\n- open_page:')).toBe(true);
        expect(catalogReads).toBeGreaterThan(0);
      } else {
        expect(JSON.parse(output.stdoutChunks.join(''))).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable' } });
        expect(catalogReads).toBe(0);
      }
      expect(selfReads).toBe(1);
      expect(machineReads).toBe(1);
      expect(openToolConnections).toBe(0);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each([
    ['with a session id', ['--session-id', 'sess-1']],
    ['without a session id', []],
  ])('prints a tools_list JSON envelope grouped by source %s', async (_label, sessionArgs) => {
    const output = captureStdoutJsonOutput();
    mcpCatalog = { v: 1, servers: [{ id: 'playwright-server', name: 'playwright', transport: 'stdio',
      stdio: { command: 'playwright-fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'playwright-binding', serverId: 'playwright-server', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand(['list', ...sessionArgs, '--directory', '/tmp/workspace', '--json'], {
        readCredentials: createBaseDeps().readCredentials,
        bootstrapAccountSettingsContext: bootstrapToolSettings(),
        listBuiltInHappierTools: projectBuiltInHappierTools,
      });

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_list');
      expect(parsed.data?.sources?.happier).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'change_title' }),
      ]));
      expect(parsed.data?.sources?.playwright).toEqual([
        expect.objectContaining({ name: 'open_page' }),
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('refuses private custom tool names when the original Account retires during OS listing', async () => {
    mcpCatalog = { v: 1, servers: [{ id: 'private-server', name: 'private-source', transport: 'stdio',
      stdio: { command: 'private-fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'private-binding', serverId: 'private-server', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    listToolsAtBoundary = async () => {
      markStarted();
      await held;
      return { tools: [{ name: 'retired-account-private-tool', inputSchema: { type: 'object' } }] };
    };
    const output = captureStdoutJsonOutput<unknown>();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const listing = handleToolsCommand(['list', '--directory', '/tmp/workspace', '--json'], {
        readCredentials: createBaseDeps().readCredentials,
        bootstrapAccountSettingsContext: bootstrapToolSettings(),
        listBuiltInHappierTools: projectBuiltInHappierTools,
      });
      await started;
      const captured = getActiveAccountSettingsSnapshot();
      if (!captured?.mcpServerCatalog) throw new Error('Expected the real admitted Account capture');
      expect(captured.mcpServerCatalog.status).toBe('ready');
      setActiveAccountSettingsSnapshot({ ...captured, scopeKey: 'retired-tools-account' });
      setActiveAccountSettingsSnapshot({ ...captured });
      release();
      await listing;
      const result = output.json();
      expect(result).toMatchObject({ ok: false, kind: 'tools_list', error: { code: 'mcp_catalog_unavailable' } });
      expect(JSON.stringify(result)).not.toContain('retired-account-private-tool');
      expect(process.exitCode).toBe(1);
    } finally {
      release();
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('does not dispatch a custom tool call when the original Account retires during SDK connection', async () => {
    prepareCustomCallCatalog();
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    connectAtBoundary = async () => { markStarted(); await held; };
    const output = captureStdoutJsonOutput<unknown>();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const calling = handleToolsCommand(['call', '--session-id', 'session-1', '--source', 'call-source',
        '--tool', 'perform_effect', '--args-json', '{}', '--json'], {
        readCredentials: createBaseDeps().readCredentials,
        bootstrapAccountSettingsContext: bootstrapToolSettings(),
      });
      await started;
      retireAndReenterToolsAccount();
      release();
      await calling;
      expect(output.json()).toMatchObject({ ok: false, kind: 'tools_call', error: { code: 'tool_call_failed' } });
      expect(outwardCalls).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally {
      release();
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('preserves the acknowledged custom tool call after the original Account retires without replay', async () => {
    prepareCustomCallCatalog();
    let markDispatched!: () => void;
    const dispatched = new Promise<void>(resolve => { markDispatched = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    callToolAtBoundary = async () => {
      markDispatched();
      await held;
      return { content: [{ type: 'text', text: 'Acknowledged' }], structuredContent: { effect: 'accepted' } };
    };
    const output = captureStdoutJsonOutput<unknown>();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const calling = handleToolsCommand(['call', '--session-id', 'session-1', '--source', 'call-source',
        '--tool', 'perform_effect', '--args-json', '{}', '--json'], {
        readCredentials: createBaseDeps().readCredentials,
        bootstrapAccountSettingsContext: bootstrapToolSettings(),
      });
      await dispatched;
      expect(outwardCalls).toEqual(['perform_effect']);
      retireAndReenterToolsAccount();
      release();
      await calling;
      expect(output.json()).toMatchObject({ ok: true, kind: 'tools_call',
        data: { output: { structuredContent: { effect: 'accepted' } } } });
      expect(outwardCalls).toEqual(['perform_effect']);
      expect(process.exitCode).toBe(0);
    } finally {
      release();
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a tools_list JSON envelope with warnings when one custom source is unavailable', async () => {
    const output = captureStdoutJsonOutput();
    mcpCatalog = { v: 1, servers: [
      { id: 'available-server', name: 'playwright', transport: 'stdio',
        stdio: { command: 'available-fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 },
      { id: 'unavailable-server', name: 'unavailable-source', transport: 'stdio',
        stdio: { command: 'unavailable-fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 },
    ], bindings: [
      { id: 'available-binding', serverId: 'available-server', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 },
      { id: 'unavailable-binding', serverId: 'unavailable-server', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 },
    ] };
    connectAtBoundary = async ({ command }) => {
      if (command === 'unavailable-fixture') throw new Error('Connection closed');
    };
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand(['list', '--session-id', 'sess-1', '--directory', '/tmp/workspace', '--json'], {
        readCredentials: createBaseDeps().readCredentials,
        bootstrapAccountSettingsContext: bootstrapToolSettings(),
        listBuiltInHappierTools: projectBuiltInHappierTools,
      });

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_list');
      expect(parsed.data?.sources?.playwright).toEqual([
        expect.objectContaining({ name: 'open_page' }),
      ]);
      expect(parsed.data?.warnings).toEqual([
        { source: 'unavailable-source', error: 'Connection closed' },
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a tools_call JSON envelope for built-in Happier tools', async () => {
    const output = captureStdoutJsonOutput();
    const initializeBackendApiContext = vi.fn(async () => ({ api: {} as any, machineId: 'machine-1' }));
    const bootstrapAccountSettingsContext = vi.fn(async () => ({ settings: {}, source: 'network', settingsVersion: 1, loadedAtMs: 1, whenRefreshed: null }));
    const resolveCustomHappierToolsContext = vi.fn(async () => {
      throw new Error('built-in tools must not materialize custom MCP state');
    });
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand([
        'call',
        '--session-id',
        'sess-1',
        '--directory',
        '/tmp/workspace',
        '--source',
        'happier',
        '--tool',
        'change_title',
        '--args-json',
        '{"title":"Renamed"}',
        '--json',
      ], {
        ...createBaseDeps(),
        initializeBackendApiContext,
        bootstrapAccountSettingsContext,
        resolveCustomHappierToolsContext,
        callBuiltInHappierTool: async ({ toolName, args, sessionId }: any) => ({
          ok: true,
          result: { toolName, args, sessionId },
        }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_call');
      expect(parsed.data).toEqual({
        source: 'happier',
        tool: 'change_title',
        isError: false,
        output: {
          toolName: 'change_title',
          args: { title: 'Renamed' },
          sessionId: 'sess-1',
        },
      });
      expect(initializeBackendApiContext).not.toHaveBeenCalled();
      expect(bootstrapAccountSettingsContext).not.toHaveBeenCalled();
      expect(resolveCustomHappierToolsContext).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('includes session ambiguity candidates in the tools_call JSON error envelope for built-in Happier tools', async () => {
    const output = captureStdoutJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand([
        'call',
        '--session-id',
        'sess',
        '--directory',
        '/tmp/workspace',
        '--source',
        'happier',
        '--tool',
        'change_title',
        '--args-json',
        '{"title":"Renamed"}',
        '--json',
      ], {
        ...createBaseDeps(),
        callBuiltInHappierTool: async () => ({
          ok: false,
          errorCode: 'session_id_ambiguous',
          error: 'Session id is ambiguous',
          candidates: ['sess-1', 'sess-2'],
        }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('tools_call');
      expect(parsed.error).toEqual({
        code: 'session_id_ambiguous',
        message: 'Session id is ambiguous',
        candidates: ['sess-1', 'sess-2'],
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it.each([
    ['does not forward', 'an ordinary CLI call', [], { surface: 'cli' }],
  ] as const)('%s native tool-call identity for %s', async (_verb, _label, bridgeArgs, expected) => {
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const callBuiltInHappierTool = vi.fn(async () => ({ ok: true as const, result: { done: true } }));

    try {
      await handleToolsCommand([
        'call',
        '--session-id', 'sess-1',
        '--directory', '/tmp/workspace',
        '--source', 'happier',
        '--tool', 'action_execute',
        '--args-json', '{"actionId":"memory.search","input":{}}',
        ...bridgeArgs,
        '--tool-call-id', 'pi-call-1',
        '--json',
      ], {
        ...createBaseDeps(),
        callBuiltInHappierTool,
      } as any);

      expect(callBuiltInHappierTool).toHaveBeenCalledOnce();
      const [request] = callBuiltInHappierTool.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(request).toMatchObject(expected);
      if (!('toolCallId' in expected)) expect(request).not.toHaveProperty('toolCallId');
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  describe('Windows Agent custom MCP transport admission', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }));
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllGlobals();
  });

  it.each(['list', 'call'])('refuses %s before borrowing the current user Account catalog or credentials', async command => {
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const readCredentials = vi.fn(async () => ({ token: 'windows-board-token', encryption: null }));

    try {
      await handleToolsCommand([
        command,
        '--agent-bridge',
        '--session-id', 'sess-1',
        ...(command === 'call' ? ['--source', 'custom', '--tool', 'echo', '--args-json', '{}'] : []),
        '--json',
      ], {
        readCredentials,
        bootstrapAccountSettingsContext: bootstrapToolSettings(),
      });

      expect(output.json()).toMatchObject({ ok: false, error: { code: 'agent_isolation_unavailable' } });
      expect(readCredentials).not.toHaveBeenCalled();
      expect(outwardCalls).toEqual([]);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  });

  it('lists built-in tools with the bootstrapped Account Action policy', async () => {
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const listBuiltInHappierTools = vi.fn(async ({ isActionEnabled }: any) => {
      expect(isActionEnabled('subagents.plan.start')).toBe(false);
      return [];
    });

    try {
      await handleToolsCommand(['list', '--session-id', 'sess-1', '--json'], {
        ...createBaseDeps(),
        bootstrapAccountSettingsContext: bootstrapToolSettings({
            actionsSettingsV1: {
              v: 1,
              actions: { 'subagents.plan.start': { disabledSurfaces: ['cli'] } },
            },
        }),
        listBuiltInHappierTools,
        listResolvedCustomHappierTools: async () => ({ tools: [], warnings: [] }),
      } as any);

      expect(listBuiltInHappierTools).toHaveBeenCalledOnce();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });
});
