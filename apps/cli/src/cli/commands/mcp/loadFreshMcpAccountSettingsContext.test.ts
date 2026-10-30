import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { McpCommandDeps } from './deps';
import { loadFreshMcpAccountSettingsContext } from './loadFreshMcpAccountSettingsContext';
import { createMcpServerActionExecuteV1, projectMcpServerActionFailureV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import type { Settings } from '@/persistence';

// HTTP and cache-file I/O are boundaries. Catalog admission, semantic edits,
// Account publication, and SavedSecret hydration run through their real owners.
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

function commandReadDeps(): Pick<McpCommandDeps, 'readStoredCredentials' | 'bootstrapAccountSettingsContext' | 'fetchServerFeaturesSnapshot'> {
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
  };
}

async function changeRules(state: 'on' | 'inherit') {
  const snapshot = await loadFreshMcpAccountSettingsContext(credentials, commandReadDeps());
  const store = createCliMcpServerStore({ credentials });
  const execute = createMcpServerActionExecuteV1({ readCatalog: async () => snapshot.mcpServerCatalog,
    mutate: (change, expectedRevision) => store.mutate(change, expectedRevision, snapshot.mcpServerCatalog),
    machine: async () => { throw new Error('Rules do not use a Machine'); } });
  return execute({ actionId: 'mcp.rules.set', input: { items: [{ serverId: server.id }],
    change: { kind: 'write', write: { place: { t: 'allMachines' }, state } } },
    context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } }).catch(projectMcpServerActionFailureV1);
}

describe('MCP command catalog admission', () => {
  beforeEach(() => {
    vi.spyOn(axios, 'get');
    vi.spyOn(axios, 'post');
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
  afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); process.exitCode = undefined; });

  it('reads the durable catalog independently of the strict-mode policy', async () => {
    const result = await loadFreshMcpAccountSettingsContext(credentials, commandReadDeps());
    expect(result.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 7, catalog });
    expect(result.settings.mcpServersStrictMode).toBe(true);
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

  it('reports a durable row conflict without claiming rules removal succeeded', async () => {
    catalog.bindings = [{ id: 'binding-1', serverId: server.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }];
    rejectWrite = true;
    expect(await changeRules('inherit')).toEqual({ ok: true, result: { ok: false, code: 'conflict' } });
    expect(catalog.bindings).toHaveLength(1);
  });

  it('reports an unknown row outcome without replaying or exposing transport details', async () => {
    catalog.bindings = [{ id: 'binding-1', serverId: server.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }];
    let submissions = 0;
    vi.mocked(axios.post).mockImplementation(async () => {
      submissions += 1;
      // The Home applied the removal, but its acknowledgement was lost.
      catalog.bindings = [];
      throw Object.assign(new Error('Authorization: Bearer private-token'), { code: 'ECONNRESET' });
    });
    const output = await changeRules('inherit');
    expect(output).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(JSON.stringify(output)).not.toContain('private-token');
    expect(submissions).toBe(1);
  });

  it('refuses an admitted operation after same-Account reentry', async () => {
    const snapshot = await loadFreshMcpAccountSettingsContext(credentials, commandReadDeps());
    const active = getActiveAccountSettingsSnapshot();
    if (!active) throw new Error('Expected admitted Account');
    setActiveAccountSettingsSnapshot({ ...active, scopeKey: 'retired-account' });
    setActiveAccountSettingsSnapshot(active);
    await expect(snapshot.operationContext.isCurrent()).resolves.toBe(false);
  });

});
