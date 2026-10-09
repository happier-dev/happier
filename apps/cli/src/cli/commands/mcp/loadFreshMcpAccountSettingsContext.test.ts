import axios from 'axios';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { McpCommandDeps } from './deps';
import { loadFreshMcpAccountSettingsContext } from './loadFreshMcpAccountSettingsContext';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import type { Settings } from '@/persistence';

// HTTP and cache-file I/O are boundaries. Catalog admission, semantic edits,
// Account publication, and SavedSecret hydration run through their real owners.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
vi.mock('@/persistence', async importOriginal => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return { ...actual,
    readSettings: vi.fn(async () => machineSettings),
    updateSettings: vi.fn(async (mutator: Parameters<typeof actual.updateSettings>[0]) => {
      machineSettings = await mutator(machineSettings);
      return machineSettings;
    }),
  };
});
vi.mock('@/api/client/serverHttpBaseUrl', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/serverHttpBaseUrl')>(),
  resolveServerHttpBaseUrl: () => 'https://home.example.test',
}));

const credentials = { token: 'mcp-command-account', encryption: null };
const server = { id: 'server-1', name: 'first', transport: 'stdio' as const,
  stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 };
let catalog: McpServerCatalogV1;
let revision: number;
let rejectWrite: boolean;
let refuseRead: boolean;
let onRead: (() => void) | undefined;
let writes: unknown[];
let machineSettings: Settings;

function commandReadDeps(): Pick<McpCommandDeps, 'readStoredCredentials' | 'bootstrapAccountSettingsContext' | 'fetchServerFeaturesSnapshot' | 'randomUUID' | 'nowMs'> {
  return {
    readStoredCredentials: async () => credentials,
    bootstrapAccountSettingsContext: input => bootstrapAccountSettingsContext({ ...input,
      honorAccountSettingsModeEnv: false,
      deps: { resolveCachePath: resolveAccountSettingsCachePath, readCache: async () => null,
        writeCache: async () => undefined,
        fetchFromServer: async () => ({ settingsVersion: 4, settingsContent: { t: 'plain', v: { mcpServersStrictMode: true } } }),
      },
    }),
    fetchServerFeaturesSnapshot: async () => ({ status: 'error', reason: 'network' }),
    randomUUID: () => 'created-id', nowMs: () => 10,
  };
}

async function commandDeps() {
  return commandReadDeps();
}

async function jsonCommand(run: () => Promise<void>) {
  const output = captureStdoutJsonOutput<unknown>();
  try { await run(); return output.json(); } finally { output.restore(); }
}

describe('MCP command catalog admission', () => {
  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    process.exitCode = undefined;
    catalog = { v: 1, servers: [server], bindings: [] };
    revision = 7;
    rejectWrite = false;
    refuseRead = false;
    onRead = undefined;
    writes = [];
    machineSettings = { schemaVersion: 6, onboardingCompleted: true };
    vi.mocked(axios.get).mockReset().mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
      if (path === '/v1/account/entity-rows/mcp') {
        onRead?.();
        return { status: 200, data: refuseRead ? { status: 'account-mode-mismatch' }
          : { status: 'present', revision, content: { t: 'plain', v: catalog } } };
      }
      if (path === '/v2/account/settings') return { status: 200, data: { version: 4,
        content: { t: 'plain', v: { mcpServersStrictMode: true } } } };
      throw new Error(`Unexpected HTTP path: ${path}`);
    });
    vi.mocked(axios.post).mockReset().mockImplementation(async (url, body) => {
      writes.push(body);
      if (new URL(String(url)).pathname !== '/v1/account/entity-rows/mcp') throw new Error('Unexpected settings write');
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      if (rejectWrite || mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision } };
      if (mutation.content?.t !== 'plain') throw new Error('Expected plain catalog');
      catalog = mutation.content.v;
      revision += 1;
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
  });
  afterEach(() => { resetInMemoryAccountSettingsContextForTests(); process.exitCode = undefined; });

  it('reads the durable catalog independently of the strict-mode policy', async () => {
    const result = await loadFreshMcpAccountSettingsContext(credentials, commandReadDeps());
    expect(result.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 7, catalog });
    expect(result.settings.mcpServersStrictMode).toBe(true);
    const { cmdMcpServersList } = await import('./servers/list');
    const deps = commandReadDeps();
    expect(await jsonCommand(() => cmdMcpServersList([], deps, { json: true })))
      .toMatchObject({ ok: true, data: { strictMode: true, servers: [{ id: 'server-1', name: 'first' }] } });
  });

  it('refuses unavailable catalog facts instead of reporting a successful empty list', async () => {
    refuseRead = true;
    await expect(loadFreshMcpAccountSettingsContext(credentials, commandReadDeps()))
      .rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'account-mode-mismatch' });
  });

  it('does not replace a retired Account capture with the new active Account', async () => {
    onRead = () => {
      const active = getActiveAccountSettingsSnapshot();
      if (active) setActiveAccountSettingsSnapshot({ ...active, scopeKey: 'another-account', settingsVersion: 5 });
    };
    await expect(loadFreshMcpAccountSettingsContext(credentials, commandReadDeps())).rejects.toMatchObject({ code: 'mcp_catalog_unavailable' });
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('another-account');
  });

  it('adds and binds through catalog row CAS while preserving the existing server', async () => {
    const { cmdMcpServersAdd } = await import('./servers/add');
    const { cmdMcpServersBind } = await import('./servers/bind');
    const deps = await commandDeps();
    expect(await jsonCommand(() => cmdMcpServersAdd(['--name', 'second', '--command', 'second-fixture'], deps, { json: true })))
      .toMatchObject({ ok: true, data: { created: { id: 'created-id', name: 'second' } } });
    expect(await jsonCommand(() => cmdMcpServersBind(['--mcp-server', 'second', '--all-machines'], deps, { json: true })))
      .toMatchObject({ ok: true, data: { createdBindingId: 'created-id' } });
    expect(catalog.servers.map(entry => entry.id)).toEqual(['server-1', 'created-id']);
    expect(catalog.bindings).toMatchObject([{ serverId: 'created-id', enabled: true, target: { t: 'allMachines' } }]);
    expect(writes).toMatchObject([{ expectedRevision: 7 }, { expectedRevision: 8 }]);
  });

  it('reports a durable row conflict without claiming binding removal succeeded', async () => {
    const { cmdMcpServersUnbind } = await import('./servers/unbind');
    const deps = await commandDeps();
    catalog.bindings = [{ id: 'binding-1', serverId: server.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }];
    rejectWrite = true;
    expect(await jsonCommand(() => cmdMcpServersUnbind(['--binding-id', 'binding-1'], deps, { json: true })))
      .toMatchObject({ ok: false, error: { code: 'mcp_catalog_conflict', settlement: { status: 'conflict', revision: 7 } } });
    expect(catalog.bindings).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('reports an unknown row outcome without replaying or exposing transport details', async () => {
    const { cmdMcpServersUnbind } = await import('./servers/unbind');
    catalog.bindings = [{ id: 'binding-1', serverId: server.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }];
    let submissions = 0;
    vi.mocked(axios.post).mockImplementation(async () => {
      submissions += 1;
      // The Home applied the removal, but its acknowledgement was lost.
      catalog.bindings = [];
      throw Object.assign(new Error('Authorization: Bearer private-token'), { code: 'ECONNRESET' });
    });
    const output = await jsonCommand(() => cmdMcpServersUnbind(['--binding-id', 'binding-1'], commandReadDeps(), { json: true }));
    expect(output).toMatchObject({ ok: false, error: { code: 'mcp_catalog_outcome_unknown', settlement: { status: 'outcomeUnknown' } } });
    expect(JSON.stringify(output)).not.toContain('private-token');
    expect(submissions).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  describe('real MCP command entrypoint', () => {
    let handleMcpCommand: typeof import('../mcp')['handleMcpCommand'];
    beforeAll(async () => {
      // Keep aggregate dispatcher setup outside command/output lifetimes.
      // Focused command-owner cases do not load this unrelated plugin graph.
      ({ handleMcpCommand } = await import('../mcp'));
    });

    it('preserves typed catalog unavailability through the real MCP command entrypoint', async () => {
      refuseRead = true;
      expect(await jsonCommand(() => handleMcpCommand(['servers', 'list', '--json'], commandReadDeps())))
        .toMatchObject({ ok: false, kind: 'mcp_servers_list', error: { code: 'mcp_catalog_unavailable' } });
      expect(process.exitCode).toBe(1);
    });

    it('reports an invalid semantic mutation through the real MCP command entrypoint without a row write', async () => {
      expect(await jsonCommand(() => handleMcpCommand(['servers', 'add', '--name', 'first', '--command', 'fixture', '--json'], commandReadDeps())))
        .toMatchObject({ ok: false, kind: 'mcp_servers_add', error: { code: 'invalid-mutation' } });
      expect(writes).toEqual([]);
      expect(catalog.servers).toEqual([server]);
      expect(process.exitCode).toBe(1);
    });

    it('preserves argument and unexpected-failure exits through the real MCP command entrypoint', async () => {
      expect(await jsonCommand(() => handleMcpCommand(['servers', 'add', '--json'], commandReadDeps())))
        .toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(process.exitCode).toBe(1);
      expect(await jsonCommand(() => handleMcpCommand(['servers', 'list', '--json'], { ...commandReadDeps(),
        readStoredCredentials: async () => { throw new Error('Credential file invariant failed'); },
      })))
        .toMatchObject({ ok: false, error: { code: 'unknown_error' } });
      expect(process.exitCode).toBe(2);
    });
  });

  it('refuses private list output after same-Account reentry across the original capture handoff', async () => {
    const { cmdMcpServersList } = await import('./servers/list');
    let scheduled = false;
    let reentered = false;
    const stop = subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (scheduled || next?.mcpServerCatalog?.status !== 'ready') return;
      scheduled = true;
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        setActiveAccountSettingsSnapshot({ ...next, scopeKey: 'retired-account' });
        setActiveAccountSettingsSnapshot({ ...next, mcpServerCatalog: { status: 'ready', authority: 'active', revision: 8,
          catalog: { v: 1, servers: [], bindings: [] }, diagnostics: [] } });
        reentered = true;
      }))));
    });
    const output = captureStdoutJsonOutput<unknown>();
    try {
      await expect(cmdMcpServersList([], commandReadDeps(), { json: true }))
        .rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
      expect(reentered).toBe(true);
      expect(output.chunks).toEqual([]);
    } finally {
      output.restore();
      stop();
    }
  });

  it('refuses private tool names after same-Account reentry while the OS probe is in flight', async () => {
    const { cmdMcpServersTest } = await import('./servers/test');
    catalog.bindings = [{ id: 'probe-binding', serverId: server.id, enabled: true,
      target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }];
    let markProbeStarted = () => {};
    const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve; });
    let releaseProbe = () => {};
    const probeResult = new Promise<Awaited<ReturnType<McpCommandDeps['probeMcpStdioServerTools']>>>(resolve => {
      releaseProbe = () => resolve([{ name: 'retired-account-private-tool' }]);
    });
    const output = captureStdoutJsonOutput<unknown>();
    const command = cmdMcpServersTest(['--mcp-server', server.id, '--dir', '/workspace'], {
      ...commandReadDeps(), ensureMachineIdForCredentials,
      probeMcpStdioServerTools: async () => { markProbeStarted(); return probeResult; },
    }, { json: true });
    try {
      await probeStarted;
      const original = getActiveAccountSettingsSnapshot();
      if (!original) throw new Error('Probe did not capture an Account');
      setActiveAccountSettingsSnapshot({ ...original, scopeKey: 'retired-account' });
      setActiveAccountSettingsSnapshot({ ...original });
      releaseProbe();
      await command;
      const result = output.json();
      expect(result).toMatchObject({ ok: false, kind: 'mcp_servers_test', error: { code: 'mcp_test_failed' } });
      expect(JSON.stringify(result)).not.toContain('retired-account-private-tool');
      expect(process.exitCode).toBe(1);
    } finally {
      releaseProbe();
      await command;
      output.restore();
    }
  });
});
