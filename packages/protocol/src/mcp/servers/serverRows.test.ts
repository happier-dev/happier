import { describe, expect, it } from 'vitest';
import { McpServersSettingsV1Schema } from './settingsV1.js';
import { McpServerCatalogEntryV1Schema } from './settingsV1.js';
import { applyMcpServerCatalogMutationV1, emptyMcpServerCatalogV1, loadMcpServerCatalogV1,
  readRetainedMcpServerCatalogSourceV1, readMcpServersFromCatalogSnapshotV1 } from './serverCatalogV1.js';
import { McpServerCatalogRowMutationV1Schema, McpServerCatalogRowReadResponseV1Schema,
  McpServerCatalogSnapshotV1Schema } from './catalogSchemasV1.js';
import { sealMcpServerCatalogContentV1, listMcpServerCatalogSavedSecretRefsV1, remapMcpServerCatalogSavedSecretReferencesV1 } from './serverRowsV1.js';
import { resolveCreateReachV1 } from '../../reach/reachRulesChangeV1.js';

describe('MCP catalog complete inventory admission', () => {
  it.each(['plain', 'e2ee'] as const)('admits real catalog mutation and sealing output through the %s row consumers', async mode => {
    const entry = McpServerCatalogEntryV1Schema.parse({ id: 'catalog-server', name: 'catalog-server', transport: 'http',
      remote: { url: 'https://example.test/mcp', urlTemplate: { t: 'template', template: 'https://example.test/{tenant}/mcp',
        vars: { tenant: { t: 'savedSecret', secretId: 'personal-tenant' } } },
        headers: { Authorization: { t: 'literal', v: 'token' } } },
      env: {}, configOverrides: [{ target: { t: 'workspace', machineId: 'machine', workspaceRoot: 'C:\\repo' },
        envPatch: { REMOVED: null, REGION: { t: 'literal', v: 'local' } }, remote: { headersPatch: { Authorization: null } } }],
      createdAt: 1, updatedAt: 1 });
    const reach = resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: 'ui' },
      ctx: { nowMs: 2, newId: () => 'catalog-rule' } });
    if (!reach.ok) throw new Error('Present-user create must resolve reach');
    const produced = applyMcpServerCatalogMutationV1(emptyMcpServerCatalogV1(), { kind: 'server-create', entry,
      rules: reach.rules.map(rule => ({ ...rule, serverId: entry.id })) });
    const material = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(19) };
    const content = sealMcpServerCatalogContentV1({ catalog: produced, mode, material });
    expect(McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: 'absent', sourceSettingsVersion: 7, content }))
      .toMatchObject({ content });
    const row = McpServerCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3, content });
    const consumed = await loadMcpServerCatalogV1({ mode, material, readRow: async () => row });
    expect(McpServerCatalogSnapshotV1Schema.parse(consumed)).toMatchObject({
      status: 'ready', authority: 'active', revision: 3, catalog: produced, diagnostics: [],
    });
    expect(McpServerCatalogRowMutationV1Schema.safeParse({ expectedRevision: 3, content, unexpected: true }).success).toBe(false);
    expect(await loadMcpServerCatalogV1({ mode: mode === 'plain' ? 'e2ee' : 'plain',
      material: mode === 'plain' ? { type: 'dataKey', machineKey: new Uint8Array(32).fill(19) } : null,
      readRow: async () => row })).toMatchObject({ status: 'unavailable', reason: 'account-mode-mismatch' });
  });

  it('censuses and rewrites URL template bindings through the catalog reference owner', () => {
    const entry = McpServerCatalogEntryV1Schema.parse({ id: 'server', name: 'server', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {}, urlTemplate: {
        t: 'template', template: 'https://example.test/{tenant}/mcp', vars: {
          tenant: { t: 'savedSecret', secretId: 'personal-tenant' },
        },
      } }, env: {}, createdAt: 1, updatedAt: 1 });
    const catalog = { v: 1 as const, servers: [entry], bindings: [] };
    expect(listMcpServerCatalogSavedSecretRefsV1(catalog)).toEqual([
      { path: 'servers[0].remote.urlTemplate.vars.tenant', secretId: 'personal-tenant' },
    ]);
    const rewritten = remapMcpServerCatalogSavedSecretReferencesV1(catalog, {
      'personal-tenant': 'happier:shared-secret:v1:tenant',
    });
    expect(listMcpServerCatalogSavedSecretRefsV1(rewritten)).toEqual([
      { path: 'servers[0].remote.urlTemplate.vars.tenant', secretId: 'happier:shared-secret:v1:tenant' },
    ]);
    expect(rewritten.servers[0]?.remote?.url).toBe('https://example.test/mcp');
  });

  it('rejects a retained binding whose definition is missing instead of activating a partial catalog', async () => {
    // Actual 0.2 shape, HEAD 37a6541578749067b49d4579be8c752c9591b8c8,
    // packages/protocol/src/mcpServers/settingsV1.ts (clean scoped worktree).
    const retained = { v: 1, strictMode: true, servers: [], bindings: [{
      id: 'binding', serverId: 'missing', enabled: true,
      target: { t: 'workspace', machineId: 'machine', workspaceRoot: 'C:\\Users\\alice\\project' },
      overrides: { envPatch: { TOKEN: null } }, createdAt: 1, updatedAt: 2,
    }] };
    expect(McpServersSettingsV1Schema.safeParse(retained).success).toBe(false);
    const definition = McpServerCatalogEntryV1Schema.parse({
      id: 'missing', name: 'example', transport: 'stdio', stdio: { command: 'node', args: [] },
      env: { TOKEN: { t: 'literal', v: 'token' } }, createdAt: 1, updatedAt: 2,
    });
    expect(readRetainedMcpServerCatalogSourceV1({
      mcpServersSettingsV1: { ...retained, servers: [definition] },
    })).toMatchObject({
      status: 'opened', strictMode: true,
      catalog: { servers: [{ id: 'missing' }], bindings: [{ id: 'binding', serverId: 'missing' }] },
    });
    const loaded = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
      readRow: async () => ({ status: 'absent' }), transfer: {
        readSourceSnapshot: async () => ({ raw: { mcpServersSettingsV1: retained }, version: 1 }),
        initializeCatalog: async () => { throw new Error('A missing definition must not activate retained bindings'); },
      } });
    expect(loaded).toMatchObject({
      status: 'partial', revision: 'absent', authority: 'inactive',
      catalog: { v: 1, servers: [], bindings: [] },
      diagnostics: [{ path: 'bindings[0]', reason: 'invalid-stored-content' }],
    });
    expect(readMcpServersFromCatalogSnapshotV1({ snapshot: loaded, strictMode: true }))
      .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });
});
