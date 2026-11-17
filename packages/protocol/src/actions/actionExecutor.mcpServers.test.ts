import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import { MCP_SERVER_ACTION_IDS_V1 } from '../mcp/servers/serverActionIdsV1.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from './actionSettings.js';
import { createMcpServerActionExecuteV1 } from '../mcp/servers/serverActionsV1.js';
import { applyMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '../mcp/servers/serverCatalogV1.js';
import type { McpServerCatalogV1 } from '../mcp/servers/serverRowsV1.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { readApprovalExecutionFailure } from '../approvals/approvalExecutionFailure.js';
import { readRecord } from '../inputs/inputRecords.js';
import { buildClaudePermissionChoices } from '../../../plugins/claude/src/agent/permissions/permissionChoices.js';
import { NativePermissionChoicesV1Schema } from '../sessions/permissions/nativeChoicesV1.js';

describe('MCP catalog Actions', () => {
  it('runs the same stored follow-up after a source-scoped remote native answer with an autoapproved catalog policy', async () => {
    const trace: string[] = [];
    const followUp = { actionId: 'mcp.servers.tools.set', input: { serverId: 'docs', tools: { write: 'allow' } } };
    const offer = { requirementId: 'occurrence', source: 'test-agent', choices: [{ id: 'remember', label: 'Remember',
      decision: 'approved' as const, scope: 'session' as const, response: { approved: true }, followUp }] };
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'docs', name: 'docs', transport: 'stdio',
      stdio: { command: 'docs-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] };
    const executor = createActionExecutor({
      readActionsSettings: () => setActionApprovalOverride({ settings: normalizeActionsSettingsV1(null),
        actionId: 'mcp.servers.tools.set', surface: 'plugin', approvalRequired: false }),
      sessionPermissionRemoteAction: async args => {
        if (args.actionId === 'session.permission.remote.pending.list') {
          expect(args.input).toMatchObject({ sessionId: 'session', sourceRef: 'source', sourceRevisionOrEpoch: 'revision' });
          return args.input.cursor ? { requests: [{ kind: 'permission', requestId: 'request', turnId: 'turn', createdAtMs: 1,
            allowedScopes: ['request', 'session'], agentRequestSummary: { kind: 'permission', toolLabel: 'Docs', title: 'Write', detail: 'Save a document' },
            nativeChoices: offer }], truncated: false, nextCursor: null } : { requests: [], truncated: false, nextCursor: 'second-page' };
        }
        trace.push('native');
        return { status: 'applied', settlementId: 'settlement', requestId: 'request', decision: 'allow', effect: { kind: 'allowOnce' } };
      },
      mcpServerAction: createMcpServerActionExecuteV1({ readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) }),
        mutate: async mutation => { trace.push('save'); catalog = applyMcpServerCatalogMutationV1(catalog, mutation);
          return { status: 'updated', revision: 2, cursor: 2 }; }, machine: async () => { throw new Error('No process'); } }),
    });
    const result = await executor.execute('session.permission.remote.respond', { sessionId: 'session', requestId: 'request', turnId: 'turn',
      sourceRef: 'source', sourceRevisionOrEpoch: 'revision', idempotencyKey: 'remote-answer', actor: { namespace: 'chat', principalId: 'person' },
      nativeChoice: { requirementId: 'occurrence', choiceId: 'remember' } }, { surface: 'plugin', authority: 'account_automation',
        runtimeAccountId: 'account', serverId: 'home', actionCaller: { kind: 'plugin', pluginId: 'acme.chat', contributionLocalId: 'chat' } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'applied' } });
    expect(trace).toEqual(['native', 'save']);
    expect(catalog.servers[0]).toMatchObject({ tools: { overrides: { write: 'allow' } } });
  });
  it('applies an offered native answer before its catalog Action and retries only a failed catalog save', async () => {
    let answered = 0;
    let saves = 0;
    let nativeApplied = true;
    let catalog: McpServerCatalogV1 = { v: 1, bindings: [], servers: [{ id: 'docs', name: 'docs', transport: 'stdio',
      stdio: { command: 'docs-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] };
    const nativeChoices = NativePermissionChoicesV1Schema.parse(JSON.parse(JSON.stringify(buildClaudePermissionChoices({
      requestId: 'occurrence', toolName: 'mcp__docs__mutate', toolInput: {},
      mcpTool: { server: 'docs', tool: 'mutate', item: { serverId: 'docs' }, serverTitle: 'Docs',
        decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } },
    }))));
    const followUp = nativeChoices.choices.find(choice => choice.id === 'mcp_always_allow')?.followUp;
    if (!followUp) throw new Error('Claude must offer catalog consent');
    const executor = createActionExecutor({

      sessionStatusGet: async () => ({ pendingRequests: [{ requestId: 'native-request', kind: 'permission', tool: 'McpTool',
        nativeChoices }] }),
      sessionPermissionRespond: async () => { answered++; return nativeApplied ? { ok: true } : { ok: false, errorCode: 'permission_request_not_found' }; },
      mcpServerAction: createMcpServerActionExecuteV1({
        readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
          readRow: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: catalog } }) }),
        mutate: async change => {
          expect(answered).toBe(1);
          if (++saves === 1) return { status: 'conflict' };
          catalog = applyMcpServerCatalogMutationV1(catalog, change);
          return { status: 'updated', revision: 2, cursor: 2 };
        },
        machine: async () => { throw new Error('Catalog consent never starts a process'); },
      }),
    });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', runtimeAccountId: 'account' };
    const failed = await executor.execute('session.permission.respond', { sessionId: 'session', requestId: 'native-request',
      nativeChoice: { requirementId: 'occurrence', choiceId: 'mcp_always_allow' },
      followUp: { actionId: 'session.delete', input: { sessionId: 'injected' } } }, context);
    expect(failed).toMatchObject({ ok: false, details: { answered: true, followUp } });
    expect(answered).toBe(1);
    expect(catalog.servers[0]?.tools).toBeUndefined();
    expect(await executor.execute('mcp.servers.tools.set', followUp.input, context)).toMatchObject({ ok: true });
    expect(catalog.servers[0]).toMatchObject({ tools: { overrides: { mutate: 'allow' } } });
    expect(answered).toBe(1);
    nativeApplied = false;
    expect(await executor.execute('session.permission.respond', { sessionId: 'session', requestId: 'native-request',
      nativeChoice: { requirementId: 'occurrence', choiceId: 'mcp_always_allow' } }, context))
      .toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
    expect(answered).toBe(2);
    expect(saves).toBe(2);
  });
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
    // The Machine adapter has already sanitized its declared public reason;
    // transport diagnostics remain private metadata beside that response.
    const publicReason = 'The MCP server could not be reached.';
    const executor = createActionExecutor({
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [context.surface ?? 'ui'] } } }),
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
          error: publicReason, stderrTail: 'private bridge diagnostic',
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
    expect(receipt).toMatchObject({ ok: true, result: { status: 'failed', execution: {
      ok: false, errorCode, error: publicReason,
    } } });
    expect(JSON.stringify(receipt)).not.toContain('private');
    const publicRead = await executor.execute('approval.request.get', { artifactId: 'mcp-test-approval' },
      { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' });
    if (!publicRead.ok) throw new Error(`Approval read failed: ${JSON.stringify(publicRead)}`);
    const publicRequest = ApprovalRequestV2Schema.parse(readRecord(publicRead.result).request);
    expect(readApprovalExecutionFailure(publicRequest)).toEqual({ ok: false,
      errorCode, error: publicReason });
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
  it('asks automation callers while keeping native UI review separate from approval custody', () => {
    for (const actionId of MCP_SERVER_ACTION_IDS_V1.filter(id => getActionSpec(id).safety === 'danger')) {
      const args = { actionId, spec: getActionSpec(actionId), context: { surface: 'ui', authority: 'present_user' } as const };
      expect(resolveActionApprovalRouting(args).required, actionId).toBe(false);
      expect(resolveActionApprovalRouting(args).uiConfirmationRequired === true, actionId)
        .toBe(getActionSpec(actionId).approvalPolicy?.uiConfirmation !== 'direct');
      for (const surface of ['cli', 'agent', 'mcp', 'plugin'] as const) {
        expect(resolveActionApprovalRouting({ ...args, context: { surface, authority: 'account_automation' } }).required, `${actionId}:${surface}`).toBe(true);
      }
      expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { [actionId]: ['ui'] } }) }).required, actionId).toBe(false);
    }
  });
  it('does not claim authoritative absence from an inactive retained-source snapshot', async () => {
    const executor = createActionExecutor({
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
    const executor = createActionExecutor({
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
