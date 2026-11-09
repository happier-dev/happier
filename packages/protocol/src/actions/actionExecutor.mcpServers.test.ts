import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import { MCP_SERVER_ACTION_IDS_V1 } from '../mcp/servers/serverActionIdsV1.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { createMcpServerActionExecuteV1 } from '../mcp/servers/serverActionsV1.js';
import { applyMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '../mcp/servers/serverCatalogV1.js';
import type { McpServerCatalogV1 } from '../mcp/servers/serverRowsV1.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { readApprovalExecutionFailure } from '../approvals/approvalExecutionFailure.js';
import { readRecord } from '../inputs/inputRecords.js';

describe('MCP catalog Actions', () => {
  it('retains MCP policy changes across private approval, public read and approved execution', async () => {
    let stored: ApprovalRequest | null = null;
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'docs', name: 'docs', transport: 'stdio',
      stdio: { command: 'docs-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] };
    const input = { serverId: 'docs', default: 'allow_read_only', tools: { read: 'allow', write: 'off', old: 'inherit' } };
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'policy-review' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      mcpServerAction: createMcpServerActionExecuteV1({
        readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
          readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) }),
        mutate: async change => {
          catalog = applyMcpServerCatalogMutationV1(catalog, change);
          return { status: 'updated', revision: 2, cursor: 2 };
        },
        machine: async () => { throw new Error('Policy changes do not launch a process'); },
      }),
    });
    await expect(executor.execute('mcp.servers.tools.set', input, { surface: 'cli', authority: 'account_automation',
      serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'policy-change', actionCaller: { kind: 'host' } }))
      .resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(readRecord(stored).actionArgs).toEqual(input);
    const read = await executor.execute('approval.request.get', { artifactId: 'policy-review' },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' });
    expect(read).toMatchObject({ ok: true, result: { request: { actionArgs: input } } });
    await expect(executor.execute('approval.request.decide', { artifactId: 'policy-review', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' }))
      .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(catalog.servers[0]).toMatchObject({ tools: { default: 'allow_read_only', overrides: { read: 'allow', write: 'off' } } });
    const settledRead = await executor.execute('approval.request.get', { artifactId: 'policy-review' },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' });
    expect(settledRead, JSON.stringify(settledRead)).toMatchObject({ ok: true,
      result: { request: { status: 'executed', actionArgs: input } } });
  });
  it.each([
    ['mcp.servers.test', { t: 'byId', serverId: 'oauth-server', machineId: 'machine', directory: '/workspace' }, 'mcp_connect_failed'],
    ['mcp.found.list', { machineId: 'machine', directory: '/workspace' }, 'internal_error'],
  ] as const)('keeps a typed %s failure in the public approval receipt without disclosing diagnostics', async (actionId, input, errorCode) => {
    let stored: ApprovalRequest | null = null;
    const executor = createActionExecutor({
      isActionApprovalRequired: id => id === actionId,
      // Artifact persistence and Machine RPC are system boundaries; admission,
      // MCP response parsing, approval replay and observation stay real.
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'mcp-test-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      mcpServerAction: createMcpServerActionExecuteV1({
        readCatalog: async () => { throw new Error('Test uses the Machine RPC'); },
        mutate: async () => { throw new Error('Test uses the Machine RPC'); },
        machine: async () => ({ ok: false, errorCode, durationMs: 10,
          error: 'private remote diagnostic', stderrTail: 'private bridge diagnostic',
          authorization: 'private bearer' }),
      }),
    });
    expect(await executor.execute(actionId, input,
      { surface: 'cli', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'account',
      actionRequestId: 'mcp-test-request', actionCaller: { kind: 'host' } }))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'mcp-test-approval' } });
    const receipt = await executor.execute('approval.request.decide', {
      artifactId: 'mcp-test-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' });
    expect(receipt).toMatchObject({ ok: true, result: { status: 'executed', execution: {
      ok: true, result: { ok: false, errorCode },
    } } });
    expect(JSON.stringify(receipt)).not.toContain('private');
    const publicRead = await executor.execute('approval.request.get', { artifactId: 'mcp-test-approval' },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' });
    if (!publicRead.ok) throw new Error(`Approval read failed: ${JSON.stringify(publicRead)}`);
    const publicRequest = ApprovalRequestV2Schema.parse(readRecord(publicRead.result).request);
    expect(readApprovalExecutionFailure(publicRequest)).toEqual({ ok: false,
      errorCode, error: errorCode });
    expect(JSON.stringify(publicRead)).not.toContain('private');
    expect(getActionSpec('mcp.servers.test').projectObservationOutput?.({ ok: false,
      errorCode: 'private arbitrary error', error: 'private diagnostic' })).toEqual({ ok: false });
  });
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
      where: { kind: 'replace', rules: [] }, expectedRevision: 3 }).success).toBe(true);
    expect(create.inputSchema.safeParse({ entry: { id: 'one', name: 'one', transport: 'stdio',
      stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 },
      where: { kind: 'replace', rules: [] }, expectedRevision: 'absent' }).success).toBe(true);
    expect(create.inputSchema.safeParse({ entry: {}, bindings: [] }).success).toBe(false);
    expect(getActionSpec('mcp.servers.delete').safety).toBe('danger');
    const test = getActionSpec('mcp.servers.test');
    expect(test.executionPlacement).toBe('machine');
    expect(test.safety).toBe('danger');
    expect(create.projectObservationInput?.({ entry: { id: 'one', env: { TOKEN: { t: 'literal', v: 'private' } } },
      expectedRevision: 3 })).toEqual({ serverId: 'one', expectedRevision: 3 });
  });
  it('asks CLI and Agent callers while applying reversible UI taps directly under D22', () => {
    for (const actionId of MCP_SERVER_ACTION_IDS_V1.filter(id => getActionSpec(id).safety === 'danger')) {
      const args = { actionId, spec: getActionSpec(actionId), context: { surface: 'ui', authority: 'present_user' } as const };
      expect(resolveActionApprovalRouting(args).required, actionId).toBe(getActionSpec(actionId).approvalPolicy?.uiConfirmation !== 'direct');
      for (const surface of ['cli', 'agent', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ ...args, context: { surface, authority: 'account_automation' } }).required, `${actionId}:${surface}`).toBe(true);
      }
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
