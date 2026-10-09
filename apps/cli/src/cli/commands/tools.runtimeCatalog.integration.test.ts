import axios from 'axios';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { handleToolsCommand } from './tools';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { listBuiltInHappierTools as projectBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { bootstrapAccountSettingsContext as bootstrapSettings, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

type BoundaryTools = { tools: Array<{ name: string; description?: string; inputSchema: { type: 'object' } }> };
let listToolsAtBoundary: () => Promise<BoundaryTools>;
let connectAtBoundary: (transport: { command: string }) => Promise<void>;
let callToolAtBoundary: () => Promise<unknown>;
let outwardCalls: string[];
let mcpCatalog: McpServerCatalogV1;

// Genuine process/SDK boundaries only: the command, row selector, materializer,
// custom resolver, and custom-list orchestration remain their actual owners.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(transport: { command: string }) { await connectAtBoundary(transport); }
    async listTools() { return await listToolsAtBoundary(); }
    async callTool(request: { name: string }) {
      outwardCalls.push(request.name);
      return await callToolAtBoundary();
    }
    async close() {}
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
  resolveServerHttpBaseUrl: () => 'https://home.example.test',
}));

function bootstrapToolSettings(raw: Readonly<Record<string, unknown>> = {}): typeof bootstrapSettings {
  return input => bootstrapSettings({ ...input, honorAccountSettingsModeEnv: false,
    deps: { resolveCachePath: resolveAccountSettingsCachePath, readCache: async () => null, writeCache: async () => undefined,
      fetchFromServer: async () => ({ settingsVersion: 1, settingsContent: { t: 'plain', v: raw } }),
    },
  });
}

beforeEach(() => {
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
afterEach(() => resetInMemoryAccountSettingsContextForTests());

const BOARD_TOOL_NAMES = [
  'session_board_get',
  'session_board_item_upsert',
  'session_board_item_remove',
  'session_board_layout_update',
] as const;

function serverFeaturesSnapshot(boardEnabled: unknown) {
  return {
    status: 'ready' as const,
    features: {
      features: {
        sessions: {
          enabled: true,
          board: { enabled: boardEnabled },
        },
      },
    },
  } as any;
}

function createBaseDeps() {
  return {
    readCredentials: async () => ({
      token: 'token',
      encryption: null,
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
  expect(captured?.mcpServerCatalog.status).toBe('ready');
  if (!captured) throw new Error('Expected the real admitted Account capture');
  setActiveAccountSettingsSnapshot({ ...captured, scopeKey: 'retired-tools-account' });
  setActiveAccountSettingsSnapshot({ ...captured });
}

describe('happier tools --json', () => {
  it('prints a tools_list JSON envelope grouped by source', async () => {
    const output = captureStdoutJsonOutput();
    mcpCatalog = { v: 1, servers: [{ id: 'playwright-server', name: 'playwright', transport: 'stdio',
      stdio: { command: 'playwright-fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'playwright-binding', serverId: 'playwright-server', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] };
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
      expect(captured?.mcpServerCatalog.status).toBe('ready');
      if (!captured) throw new Error('Expected the real admitted Account capture');
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

  it('allows happier tools list without a session id', async () => {
    const output = captureStdoutJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand(['list', '--directory', '/tmp/workspace', '--json'], {
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

  it('forwards native tool-call identity only for the internal Agent bridge', async () => {
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
        '--agent-bridge',
        '--tool-call-id', 'pi-call-1',
        '--json',
      ], {
        ...createBaseDeps(),
        callBuiltInHappierTool,
      } as any);

      expect(callBuiltInHappierTool).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'agent',
        toolCallId: 'pi-call-1',
      }));
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('dispatches the generated shell-bridge call as Agent automation even with stored human credentials', async () => {
    const { buildHappierToolsShellBridgeCommand } = await import(
      '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand'
    );
    const { parseHappierToolsShellBridgeCommand } = await import('@happier-dev/protocol');
    const generated = buildHappierToolsShellBridgeCommand([
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
    ]);
    const parsed = parseHappierToolsShellBridgeCommand(generated);
    expect(parsed).toMatchObject({ kind: 'call', agentBridge: true });

    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const callBuiltInHappierTool = vi.fn(async () => ({ ok: true as const, result: { done: true } }));

    try {
      // The exact argv the generated command runs, taken from the producer
      // rather than restated by hand.
      await handleToolsCommand([
        'call',
        '--agent-bridge',
        '--session-id', 'sess-1',
        '--directory', '/tmp/workspace',
        '--source', 'happier',
        '--tool', 'change_title',
        '--args-json', '{"title":"Renamed"}',
        '--json',
      ], {
        ...createBaseDeps(),
        callBuiltInHappierTool,
      } as any);

      expect(callBuiltInHappierTool).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'agent',
      }));
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('lists tools on the Agent surface for the generated shell bridge', async () => {
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const listBuiltInHappierTools = vi.fn(async () => []);

    try {
      await handleToolsCommand(['list', '--agent-bridge', '--session-id', 'sess-1', '--json'], {
        ...createBaseDeps(),
        listBuiltInHappierTools,
        listResolvedCustomHappierTools: async () => ({ tools: [], warnings: [] }),
      } as any);

      expect(listBuiltInHappierTools).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'agent',
      }));
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    ['missing exact Session target', serverFeaturesSnapshot(true), false],
    ['missing snapshot', undefined, true],
    ['malformed snapshot', serverFeaturesSnapshot('yes'), true],
    ['disabled snapshot', serverFeaturesSnapshot(false), true],
  ])('fails closed for server-backed Board tools on the shell Agent bridge with a %s', async (_label, snapshot, withSession) => {
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand([
        'list',
        '--agent-bridge',
        ...(withSession ? ['--session-id', 'sess-1'] : []),
        '--json',
      ], {
        ...createBaseDeps(),
        initializeBackendApiContext: async () => ({
          api: { getServerFeaturesSnapshot: async () => snapshot } as any,
          machineId: 'machine-1',
        }),
        listBuiltInHappierTools: async (params: any) => projectBuiltInHappierTools(params),
        listResolvedCustomHappierTools: async () => ({ tools: [], warnings: [] }),
      } as any);

      const names = output.json<any>().data.sources.happier.map((tool: { name: string }) => tool.name);
      for (const boardToolName of BOARD_TOOL_NAMES) {
        expect(names).not.toContain(boardToolName);
      }
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('advertises all Board tools only from the shell Agent bridge target Home enabled snapshot', async () => {
    const seenByToken = new Map<string, readonly string[]>();

    for (const [token, enabled] of [['home-a-token', false], ['home-b-token', true]] as const) {
      const output = captureStdoutJsonOutput();
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await handleToolsCommand(['list', '--agent-bridge', '--session-id', 'same-session-id', '--json'], {
          ...createBaseDeps(),
          readCredentials: async () => ({ token, encryption: null }),
          initializeBackendApiContext: async ({ credentials }: any) => ({
            api: {
              getServerFeaturesSnapshot: async () => serverFeaturesSnapshot(
                credentials.token === 'home-b-token',
              ),
            } as any,
            machineId: 'machine-1',
          }),
          listBuiltInHappierTools: async (params: any) => projectBuiltInHappierTools(params),
          listResolvedCustomHappierTools: async () => ({ tools: [], warnings: [] }),
        } as any);
        seenByToken.set(
          token,
          output.json<any>().data.sources.happier.map((tool: { name: string }) => tool.name),
        );
      } finally {
        output.restore();
        process.exitCode = previousExitCode;
      }
    }

    for (const boardToolName of BOARD_TOOL_NAMES) {
      expect(seenByToken.get('home-a-token')).not.toContain(boardToolName);
    }
    expect(seenByToken.get('home-b-token')).toEqual(expect.arrayContaining([...BOARD_TOOL_NAMES]));
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
