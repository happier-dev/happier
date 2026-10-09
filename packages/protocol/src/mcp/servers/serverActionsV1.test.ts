import { describe, expect, it } from 'vitest';
import { MCP_SERVER_ACTION_SPECS_V1 } from '../../actions/specs/mcpServers.js';
import { MCP_SERVER_ACTION_IDS_V1 } from './serverActionIdsV1.js';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_INPUT_SCHEMAS_V1,
  MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from './serverActionsV1.js';
import { applyMcpServerCatalogMutationV1, commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from './serverCatalogV1.js';
import type { McpServerCatalogV1 } from './serverRowsV1.js';

describe('canonical MCP Action owner', () => {
  it('declares the complete closed family and requires explicit destructive cleanup input', () => {
    expect(new Set(MCP_SERVER_ACTION_SPECS_V1.map(spec => spec.id))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    expect(new Set(Object.keys(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    expect(new Set(Object.keys(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1))).toEqual(new Set(MCP_SERVER_ACTION_IDS_V1));
    const deletion = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.delete'];
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server' }).success).toBe(false);
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server', removeBindings: true, shell: 'unsafe' }).success).toBe(false);
    expect(deletion.safeParse({ expectedRevision: 9, serverId: 'server', removeBindings: true }).success).toBe(true);
    for (const id of ['mcp.servers.create', 'mcp.servers.delete', 'mcp.bindings.remove', 'mcp.servers.test'] as const) {
      expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === id)?.safety).toBe('danger');
    }
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.test')?.executionPlacement).toBe('machine');
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.list')?.executionPlacement).toBe('account');
  });

  it('keeps list configuration private and removes referenced bindings only on explicit cleanup', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'server', transport: 'http',
      remote: { url: 'https://example.test/private-path', headers: { Authorization: { t: 'literal', v: 'private-header' } } },
      env: { TOKEN: { t: 'literal', v: 'private-token' } }, createdAt: 1, updatedAt: 2 }],
      bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' },
        overrides: { envPatch: { TOKEN: { t: 'literal', v: 'private-patch' } } }, createdAt: 1, updatedAt: 2 }] };
    const original = catalog;
    let revision = 9;
    // The row persistence boundary is in-memory. The real catalog loader,
    // semantic reducer and public MCP Action executor remain beneath it.
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: async (change, expectedRevision) => {
        expect(expectedRevision).toBe(revision);
        catalog = applyMcpServerCatalogMutationV1(catalog, change);
        return { status: 'updated', revision: ++revision, cursor: revision };
      },
      machine: async () => { throw new Error('Catalog operations cannot execute on a Machine'); },
    });
    const context = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.servers.list', input: {}, context })).toEqual({ ok: true, result: {
      status: 'ready', revision: 9, authority: 'active', diagnostics: [], catalog: { v: 1,
        servers: [{ id: 'server', name: 'server', transport: 'http', createdAt: 1, updatedAt: 2 }],
        bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2 }] },
    } });
    expect(await execute({ actionId: 'mcp.servers.read', input: { serverId: 'server' }, context })).toMatchObject({
      ok: true, result: { status: 'present', server: original.servers[0], bindings: original.bindings, revision: 9 },
    });
    await expect(execute({ actionId: 'mcp.servers.delete', input: {
      expectedRevision: 9, serverId: 'server', removeBindings: false }, context })).rejects.toThrow();
    expect(catalog).toEqual(original);
    expect(revision).toBe(9);
    expect(await execute({ actionId: 'mcp.servers.delete', input: {
      expectedRevision: 9, serverId: 'server', removeBindings: true }, context })).toEqual({
      ok: true, result: { status: 'updated', revision: 10, cursor: 10 },
    });
    expect(catalog).toEqual({ v: 1, servers: [], bindings: [] });
  });

  it('creates imported definitions and bindings in one row CAS and refuses a batch atomically', async () => {
    let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
    let revision = 9;
    const entries = [
      { entry: { id: 'alpha', name: 'alpha', transport: 'stdio', stdio: { command: 'echo', args: [] },
        env: { TOKEN: { t: 'literal', v: 'private-batch-token' } }, createdAt: 1, updatedAt: 1 }, bindings: [{ id: 'alpha-binding', serverId: 'alpha', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] },
      { entry: { id: 'beta', name: 'beta', transport: 'http', remote: { url: 'https://example.test/mcp', headers: {} },
        env: {}, createdAt: 1, updatedAt: 1 }, bindings: [{ id: 'beta-binding', serverId: 'beta', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] },
    ] satisfies { entry: McpServerCatalogV1['servers'][number]; bindings: McpServerCatalogV1['bindings'] }[];
    // Only the durable row boundary is replaced. Batch admission, reduction,
    // validation, commit sequencing and Action projection remain canonical.
    const execute = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
      mutate: async (change, expectedRevision) => {
        if (expectedRevision !== revision) return { status: 'conflict', revision };
        return commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
          writeCatalog: async candidate => {
            if (candidate.expectedRevision !== revision) return { status: 'conflict', revision };
            catalog = candidate.catalog;
            return { status: 'updated', revision: ++revision, cursor: revision };
          } });
      },
      machine: async () => { throw new Error('Import cannot execute on a Machine'); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(await execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 9, entries }, context }))
      .toEqual({ ok: true, result: { status: 'updated', revision: 10, cursor: 10 } });
    expect(MCP_SERVER_ACTION_SPECS_V1.find(spec => spec.id === 'mcp.servers.create')?.projectObservationInput?.({
      expectedRevision: 9, entries,
    })).toEqual({ expectedRevision: 9, serverIds: ['alpha', 'beta'] });
    const committed = { v: 1, servers: entries.map(item => item.entry), bindings: entries.flatMap(item => item.bindings) };
    expect(catalog).toEqual(committed);
    expect(await execute({ actionId: 'mcp.servers.list', input: {}, context })).toMatchObject({
      ok: true, result: { status: 'ready', authority: 'active', revision: 10,
        catalog: { servers: [{ id: 'alpha' }, { id: 'beta' }], bindings: [{ id: 'alpha-binding' }, { id: 'beta-binding' }] } },
    });
    const first = entries[0]!;
    expect(MCP_SERVER_ACTION_INPUT_SCHEMAS_V1['mcp.servers.create'].safeParse({ expectedRevision: 10,
      entries, entry: first.entry, bindings: first.bindings }).success).toBe(false);
    await expect(execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 10, entries: [
      { entry: { ...first.entry, id: 'next', name: 'next' },
        bindings: [{ ...first.bindings[0]!, id: 'next-binding' }] },
    ] }, context })).rejects.toMatchObject({ code: 'invalid-mutation' });
    await expect(execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 10, entries: [
      { entry: { ...first.entry, id: 'next', name: 'next' },
        bindings: [{ ...first.bindings[0]!, id: 'next-binding', serverId: 'next' }] },
      first,
    ] }, context })).rejects.toMatchObject({ code: 'invalid-mutation' });
    expect(catalog).toEqual(committed);
    expect(revision).toBe(10);
  });
});
