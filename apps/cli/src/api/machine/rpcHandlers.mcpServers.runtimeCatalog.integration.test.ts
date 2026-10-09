import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

// Home transport/cache-file I/O and process probing are real system boundaries.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/api/client/serverHttpBaseUrl', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/serverHttpBaseUrl')>(),
  resolveServerHttpBaseUrl: () => 'https://home.example.test',
}));

const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true,
  servers: [{ id: 'srv-row', name: 'row-server', transport: 'stdio', stdio: { command: 'fixture', args: [] },
    env: { KEEP: { t: 'literal', v: 'present' }, REMOVE: { t: 'literal', v: 'removed' } }, createdAt: 1, updatedAt: 1 }],
  bindings: [{ id: 'binding-row', serverId: 'srv-row', enabled: true,
    target: { t: 'workspace', machineId: 'm1', workspaceRoot: 'C:\\workspace' },
    overrides: { envPatch: { REMOVE: null, EXTRA: { t: 'literal', v: 'override' } } }, createdAt: 1, updatedAt: 1 }],
});
const catalog = { v: 1 as const, servers: settings.servers, bindings: settings.bindings };

function register(input: Readonly<{ unavailable?: boolean; retire?: boolean; retireDuringMaterialization?: boolean;
  retireDuringDetection?: boolean; reenterDuringHandoff?: boolean;
  probeResult?: () => Promise<ReadonlyArray<Readonly<{ name: string }>>> }> = {}) {
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
  let reentered = false;
  let probeObservedReentry = false;
  const probe = vi.fn(async () => {
    probeObservedReentry = reentered;
    return input.probeResult ? input.probeResult() : [{ name: 'echo' }];
  });
  let handoffScheduled = false;
  const stopHandoffObservation = input.reenterDuringHandoff ? subscribeActiveAccountSettingsSnapshot((_previous, next) => {
    if (handoffScheduled || next?.mcpServerCatalog?.status !== 'ready') return;
    handoffScheduled = true;
    // The real admission/readable/prepare/load Promise handoff runs between
    // these microtasks. Re-entry preserves scope, but retires its lifetime.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      setActiveAccountSettingsSnapshot({ ...next, scopeKey: 'retired-account' });
      setActiveAccountSettingsSnapshot({ ...next, mcpServerCatalog: { status: 'ready', authority: 'active', revision: 4,
        catalog: { v: 1, servers: [], bindings: [] }, diagnostics: [] } });
      reentered = true;
    }))));
  }) : () => undefined;
  const retireAccount = () => {
    const active = getActiveAccountSettingsSnapshot();
    if (active) setActiveAccountSettingsSnapshot({ ...active, scopeKey: 'replacement-account', settingsVersion: 5 });
  };
  const env: NodeJS.ProcessEnv = {};
  if (input.retireDuringMaterialization) {
    // OS environment expansion is a boundary during real async materialization.
    Object.defineProperty(env, 'RETIRE_ACCOUNT', { get: () => { retireAccount(); return 'expanded'; } });
  }
  vi.mocked(axios.get).mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
    if (path === '/v1/account/entity-rows/mcp') {
      if (input.retire) retireAccount();
      const rowCatalog = input.retireDuringMaterialization ? { ...catalog, servers: catalog.servers.map(server => ({ ...server,
        env: { ...server.env, KEEP: { t: 'literal' as const, v: '${RETIRE_ACCOUNT}' } },
      })) } : catalog;
      return { status: 200, data: input.unavailable ? { status: 'account-mode-mismatch' }
        : { status: 'present', revision: 3, content: { t: 'plain', v: rowCatalog } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    throw new Error(`Unexpected HTTP path: ${path}`);
  });
  registerMachineMcpServersRpcHandlers({
    rpcHandlerManager: { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => { handlers.set(method, handler); } } as never,
    deps: {
      env, readCredentials: async () => ({ token: 'rpc-mcp-account', encryption: null }),
      bootstrapAccountSettingsContext: input => bootstrapAccountSettingsContext({ ...input,
        honorAccountSettingsModeEnv: false, deps: { resolveCachePath: resolveAccountSettingsCachePath,
          readCache: async () => null, writeCache: async () => undefined,
          fetchFromServer: async () => ({ settingsVersion: 4, settingsContent: { t: 'plain', v: {} } }),
        },
      }),
      probeMcpStdioServerTools: probe,
      detectProviderMcpServers: async () => {
        if (input.retireDuringDetection) retireAccount();
        return { servers: [], warnings: [] };
      },
    },
  });
  return { handlers, probe, stopHandoffObservation, didReenter: () => reentered, probeObservedReentry: () => probeObservedReentry };
}

describe('Machine MCP catalog admission', () => {
  beforeEach(() => { resetInMemoryAccountSettingsContextForTests(); vi.mocked(axios.get).mockReset(); });
  afterEach(() => resetInMemoryAccountSettingsContextForTests());

  it('tests a saved row server with Windows binding roots and nullable env patches', async () => {
    const { handlers, probe } = register();
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace\\child', serverId: 'srv-row', bindingId: 'binding-row',
    });
    expect(result).toEqual({ ok: true, toolCount: 1, toolNamesSample: ['echo'], durationMs: expect.any(Number) });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({
      env: { KEEP: 'present', EXTRA: 'override' },
    }) }));
  });

  it('returns a typed refusal for unavailable catalog facts before probing', async () => {
    const { handlers, probe } = register({ unavailable: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses a retired finite Account capture rather than using another active catalog', async () => {
    const { handlers, probe } = register({ retire: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(probe).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement-account');
  });

  it('refuses OS probe dispatch when literal-only materialization retires the captured Account', async () => {
    const { handlers, probe } = register({ retireDuringMaterialization: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement-account');
    expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses private preview results when machine detection retires the captured Account', async () => {
    const { handlers } = register({ retireDuringDetection: true });
    const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW)!({
      machineId: 'm1', directory: 'C:\\workspace', agentId: 'claude',
    });
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement-account');
    expect(result).toMatchObject({ ok: false, errorCode: 'internal_error' });
    expect(result).not.toHaveProperty('managed');
  });

  it('keeps original Account lifetime custody across an admitted-load handoff', async () => {
    const { handlers, probe, stopHandoffObservation, didReenter, probeObservedReentry } = register({ reenterDuringHandoff: true });
    try {
      const result = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
        t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
      });
      expect(didReenter()).toBe(true);
      // If the incumbent dispatched, establish that it blessed the old facts
      // after re-entry rather than merely observing an already-issued effect.
      if (probe.mock.calls.length > 0) expect(probeObservedReentry()).toBe(true);
      expect(result).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      stopHandoffObservation();
    }
  });

  it('refuses private tool names after same-Account reentry while the OS probe is in flight', async () => {
    let markProbeStarted = () => {};
    const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve; });
    let releaseProbe = () => {};
    const probeResult = new Promise<ReadonlyArray<Readonly<{ name: string }>>>(resolve => {
      releaseProbe = () => resolve([{ name: 'retired-account-private-tool' }]);
    });
    const { handlers } = register({ probeResult: async () => { markProbeStarted(); return probeResult; } });
    const request = handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'byId', machineId: 'm1', directory: 'C:\\workspace', serverId: 'srv-row',
    });
    try {
      await probeStarted;
      const original = getActiveAccountSettingsSnapshot();
      if (!original) throw new Error('Probe did not capture an Account');
      setActiveAccountSettingsSnapshot({ ...original, scopeKey: 'retired-account' });
      setActiveAccountSettingsSnapshot({ ...original });
      releaseProbe();
      const result = await request;
      expect(result).toMatchObject({ ok: false, errorCode: 'mcp_list_tools_failed' });
      expect(JSON.stringify(result)).not.toContain('retired-account-private-tool');
    } finally {
      releaseProbe();
      await request;
    }
  });
});
