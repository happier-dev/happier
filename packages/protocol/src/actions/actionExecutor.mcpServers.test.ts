import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import { MCP_SERVER_ACTION_IDS_V1 } from '../mcp/servers/serverActionIdsV1.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createMcpServerActionExecuteV1 } from '../mcp/servers/serverActionsV1.js';
import { loadMcpServerCatalogV1 } from '../mcp/servers/serverCatalogV1.js';

describe('MCP catalog Actions', () => {
  it('declares revisioned catalog CRUD and exact-machine process tests with redacted observations', () => {
    for (const id of MCP_SERVER_ACTION_IDS_V1) {
      expect(ACTION_IDS).toContain(id);
      expect(ActionIdSchema.parse(id)).toBe(id);
      expect(getActionSpec(id).id).toBe(id);
    }
    const create = getActionSpec('mcp.servers.create');
    expect(create.executionPlacement).toBe('account');
    expect(create.inputSchema.safeParse({ entry: { id: 'one', name: 'one', transport: 'stdio',
      stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 },
      bindings: [], expectedRevision: 3 }).success).toBe(true);
    expect(create.inputSchema.safeParse({ entry: { id: 'one', name: 'one', transport: 'stdio',
      stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 },
      bindings: [], expectedRevision: 'absent' }).success).toBe(true);
    expect(create.inputSchema.safeParse({ entry: {}, bindings: [] }).success).toBe(false);
    expect(getActionSpec('mcp.servers.delete').safety).toBe('danger');
    const test = getActionSpec('mcp.servers.test');
    expect(test.executionPlacement).toBe('machine');
    expect(test.safety).toBe('danger');
    expect(create.projectObservationInput?.({ entry: { id: 'one', env: { TOKEN: { t: 'literal', v: 'private' } } },
      expectedRevision: 3 })).toEqual({ serverId: 'one', expectedRevision: 3 });
  });
  it('keeps credential configuration, process tests and destructive deletion Ask-first on present-user UI', () => {
    for (const actionId of ['mcp.servers.create', 'mcp.servers.update', 'mcp.servers.delete',
      'mcp.bindings.enable', 'mcp.bindings.remove', 'mcp.servers.test'] as const) {
      const args = { actionId, spec: getActionSpec(actionId), context: { surface: 'ui', authority: 'present_user' } as const };
      expect(resolveActionApprovalRouting(args).required, actionId).toBe(true);
      expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] } }) }).required, actionId).toBe(false);
    }
  });
  it('does not claim authoritative absence from an inactive retained-source snapshot', async () => {
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      mcpServerAction: createMcpServerActionExecuteV1({
        // Replace the row/source persistence boundary, retaining the real loader
        // and Action projection beneath it.
        readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
          readRow: async () => ({ status: 'absent' }), transfer: {
            readSourceSnapshot: async () => ({ version: 1, raw: { mcpServersSettingsV1: { v: 1,
              strictMode: false, servers: [], bindings: [] } } }),
            initializeCatalog: async () => { throw new Error('Inactive source cannot initialize'); },
          } }),
        mutate: async () => { throw new Error('Read cannot mutate'); },
        machine: async () => { throw new Error('Read cannot execute on a Machine'); },
      }) });
    expect(await executor.execute('mcp.servers.read', { serverId: 'missing' },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } })).toEqual({ ok: true,
      result: { status: 'ready', authority: 'inactive', revision: 'absent', diagnostics: [],
        catalog: { v: 1, servers: [], bindings: [] } } });
  });
  it('lists metadata without disclosing executable configuration or literal credentials', async () => {
    const executor = createActionExecutor({ isActionApprovalRequired: () => false,
      mcpServerAction: createMcpServerActionExecuteV1({
        // Only the persisted row boundary is replaced; the catalog opener and
        // public Action executor must apply the real list-disclosure contract.
        readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
          readRow: async () => ({ status: 'present', revision: 4, content: { t: 'plain', v: {
            v: 1, servers: [{ id: 'local', name: 'local', title: 'Local tools', transport: 'stdio',
              stdio: { command: 'private-command', args: ['private-argument'] },
              env: { TOKEN: { t: 'literal', v: 'private-token' } }, createdAt: 1, updatedAt: 2 },
            { id: 'remote', name: 'remote', transport: 'http',
              remote: { url: 'https://example.test/private-path', headers: {
                Authorization: { t: 'literal', v: 'private-header' } } }, env: {}, createdAt: 1, updatedAt: 2 }],
            bindings: [{ id: 'binding', serverId: 'local', enabled: true, target: { t: 'allMachines' },
              overrides: { stdio: { args: ['private-override'] }, envPatch: {
                TOKEN: { t: 'literal', v: 'private-patch' } } }, createdAt: 1, updatedAt: 2 }],
          } } }) }),
        mutate: async () => { throw new Error('List cannot mutate'); },
        machine: async () => { throw new Error('List cannot execute on a Machine'); },
      }) });
    expect(await executor.execute('mcp.servers.list', {},
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } })).toEqual({ ok: true,
      result: { status: 'ready', revision: 4, authority: 'active', diagnostics: [], catalog: {
        v: 1, servers: [{ id: 'local', name: 'local', title: 'Local tools', transport: 'stdio', createdAt: 1, updatedAt: 2 },
          { id: 'remote', name: 'remote', transport: 'http', createdAt: 1, updatedAt: 2 }],
        bindings: [{ id: 'binding', serverId: 'local', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 2 }],
      } } });
  });
});
