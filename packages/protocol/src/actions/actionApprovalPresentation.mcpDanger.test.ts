import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { describeApprovalActionFields, describeApprovalRequestFields, resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { settleApprovalRequestActionArgs } from '../approvals/approvalRequestTransition.js';
import type { McpServerActionIdV1 } from '../mcp/servers/serverActionsV1.js';
import { createActionExecutor } from './actionExecutor.js';

const entry = { id: 'mcp-a', name: 'issues', title: 'Issue tracker', transport: 'stdio',
  stdio: { command: 'issue-mcp', args: ['--workspace', 'team'] },
  env: { TOKEN: { t: 'literal', v: 'private-secret-sentinel' } }, createdAt: 1, updatedAt: 1 };
const where = { kind: 'write', write: { place: { t: 'machine', machineId: 'machine-a' }, state: 'on' } };
const cases: readonly (readonly [McpServerActionIdV1, unknown, readonly string[]])[] = [
  ['mcp.servers.create', { entry, where, expectedRevision: 1 }, ['issue-mcp', '--workspace', 'team', 'Issue tracker', 'machine-a']],
  ['mcp.servers.create', { entries: [{ entry, where }], expectedRevision: 1 }, ['issue-mcp', '--workspace', 'Issue tracker', 'machine-a']],
  ['mcp.servers.update', { entry, expectedRevision: 1 }, ['issue-mcp', '--workspace', 'Issue tracker']],
  ['mcp.servers.duplicate', { serverId: 'original' }, ['original', 'Everywhere']],
  ['mcp.servers.delete', { serverId: 'mcp-a', removeBindings: true, expectedRevision: 1 }, ['mcp-a', 'Remove rules']],
  ['mcp.servers.tools.set', { serverId: 'mcp-a', default: 'allow_read_only', tools: { delete_issue: 'allow', search: 'off', list: 'inherit' } },
    ['delete_issue', 'Allow', 'search', 'Off', 'Use server default', 'Allow read-only']],
  ['mcp.servers.test', { t: 'byId', machineId: 'machine-a', directory: '/work', serverId: 'mcp-a' }, ['mcp-a', 'machine-a', '/work']],
  ['mcp.servers.signIn.start', { serverId: 'mcp-a', stepUp: true }, ['mcp-a', 'More access']],
  ['mcp.servers.import', { source: { kind: 'paste', text: JSON.stringify({ mcpServers: { issues: {
    command: 'issue-mcp', args: ['--workspace', 'team'], env: { TOKEN: 'private-secret-sentinel' },
  } } }) }, dryRun: false, where }, ['issues', 'issue-mcp', '--workspace', 'team', 'machine-a']],
  ['mcp.found.adopt', { machineId: 'machine-a', items: [{ provider: 'claude', name: 'issues', transport: 'stdio',
    stdio: entry.stdio, envKeys: ['TOKEN'], enabled: true, source: { kind: 'user', path: '/home/test/.claude.json' } }], where }, ['issues', 'issue-mcp', 'team', 'machine-a']],
  ['mcp.servers.create', { entry: { ...entry, transport: 'http', stdio: undefined,
    remote: { url: 'https://example.test/mcp', headers: { Authorization: { t: 'literal', v: 'private-secret-sentinel' } }, auth: { kind: 'oauth' } } }, expectedRevision: 1 },
    ['https://example.test/mcp', 'Authorization', 'OAuth', 'Everywhere']],
  ['mcp.servers.create', { from: { registry: { sourceId: 'registry-a', itemId: 'issues', version: '1.0.0' } },
    name: 'issues', title: 'Issue tracker', expectedRevision: 1 }, ['registry-a', 'issues', 'Issue tracker', '1.0.0', 'Everywhere']],
  ['mcp.servers.update', { entry, expectedRevision: 1, configOverrides: [{ target: { t: 'machine', machineId: 'machine-a' },
    stdio: { command: 'alternate-mcp', args: ['--team', 'other'] }, envPatch: { TOKEN: { t: 'literal', v: 'private-secret-sentinel' } } }] },
    ['alternate-mcp', 'other', 'machine-a', 'TOKEN']],
  ['mcp.servers.update', { entry: { ...entry, stdio: { ...entry.stdio, cwd: { t: 'path', path: '/base-folder' } } },
    expectedRevision: 1, configOverrides: [{ target: { t: 'machine', machineId: 'machine-a' }, stdio: { cwd: { t: 'session' } } }] },
    ['/base-folder', 'Session folder', 'machine-a']],
  ['mcp.servers.import', { source: { kind: 'link', url: 'https://example.test/config.json' }, dryRun: false }, ['https://example.test/config.json', 'Everywhere']],
];

describe('MCP danger approval review', () => {
  it.each([
    ['mcp.servers.tools.set', { serverId: 'mcp-a', default: 'allow_read_only', tools: { read: 'allow', write: 'off', old: 'inherit' } },
      { default: 'allow_read_only', tools: { read: 'allow', write: 'off', old: 'inherit' } }],
    ['mcp.servers.delete', { serverId: 'mcp-a', expectedRevision: 1, removeBindings: true }, { removeBindings: true }],
    ['mcp.servers.delete', { serverId: 'mcp-a', expectedRevision: 1, removeBindings: false }, { removeBindings: false }],
    ['mcp.servers.signIn.start', { serverId: 'mcp-a', stepUp: true }, { stepUp: true }],
    ['mcp.servers.signIn.start', { serverId: 'mcp-a', stepUp: false }, { stepUp: false }],
    ['mcp.servers.import', { source: { kind: 'paste', text: '{}' }, dryRun: true, where }, { dryRun: true, where }],
    ['mcp.servers.import', { source: { kind: 'paste', text: '{}' }, dryRun: false, where }, { dryRun: false, where }],
  ] as const)('%s retains non-content control operands in public observations', (actionId, raw, controls) => {
    const spec = getActionSpec(actionId);
    const admitted = spec.inputSchema.parse(raw);
    expect(spec.projectObservationInput?.(admitted)).toMatchObject(controls);
    const reviewed = spec.approvalPresentation?.projectInput?.(admitted);
    expect(spec.projectObservationInput?.(reviewed)).toMatchObject(controls);
  });
  it.each([
    [undefined, undefined],
    [{ clientId: 'public-app' }, { oauthApp: 'set', clientId: 'public-app' }],
    [{ clientId: 'replacement-app', clientSecret: 'private-secret-sentinel' }, { oauthApp: 'set', clientId: 'replacement-app' }],
    [null, { oauthApp: 'remove' }],
  ] as const)('reviews an OAuth app change without retaining its secret: %j', async (client, change) => {
    const clientSecret = crypto.randomUUID();
    const raw = { serverId: 'mcp-a', ...(client === undefined ? {} : { client: client && {
      ...client, ...('clientSecret' in client ? { clientSecret } : {}),
    } }) };
    const spec = getActionSpec('mcp.servers.signIn.start');
    let stored: import('../approvals/approvalRequestV1.js').ApprovalRequestV2 | undefined;
    const executor = createActionExecutor({ isActionApprovalRequired: () => true,
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'oauth-review' }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request: { ...request, status: 'rejected' } }),
    });
    await executor.execute(spec.id, raw, { surface: 'cli', authority: 'account_automation', serverId: 'home',
      actionCaller: { kind: 'host' }, actionRequestId: 'live-oauth-review' });
    expect(spec.approvalPresentation?.projectInput?.(raw)).toEqual({ serverId: 'mcp-a', ...change });
    if (!stored) throw new Error('No OAuth approval was created');
    expect(JSON.stringify(stored).includes(clientSecret)).toBe(false);
    expect(JSON.stringify(spec.projectObservationInput!(raw)).includes(clientSecret)).toBe(false);
    expect(JSON.stringify(spec.approvalPresentation?.projectInput?.(raw)).includes(clientSecret)).toBe(false);
    expect(spec.inputHints?.fields.find(field => field.path === 'client.clientSecret')?.widget).toBe('secret');
    const pending = describeApprovalRequestFields(stored);
    expect(pending.unrepresentable).toBeNull();
    const visible = JSON.stringify(pending);
    if (change) {
      expect(pending.rows).toContainEqual(expect.objectContaining({ path: 'oauthApp', value: change.oauthApp === 'set'
        ? 'Set or replace OAuth app' : 'Remove OAuth app' }));
      if ('clientId' in change) expect(visible).toContain(change.clientId);
    } else expect(pending.rows.some(row => row.path === 'oauthApp')).toBe(false);
    const settled = { ...stored, status: 'rejected' as const, actionArgs: settleApprovalRequestActionArgs(stored) };
    expect(describeApprovalRequestFields(settled)).toEqual(pending);
    for (const presentation of [pending, settled]) {
      expect(JSON.stringify(presentation)).not.toContain(clientSecret);
      expect(JSON.stringify(presentation)).not.toContain('clientSecret');
    }
  });
  it('the actual live-only approval producer stores safe review but never raw import replay arguments', async () => {
    const spec = getActionSpec('mcp.servers.import');
    const raw = cases.find(([id]) => id === spec.id)![1];
    let stored: import('../approvals/approvalRequestV1.js').ApprovalRequestV2 | undefined;
    const executor = createActionExecutor({
      isActionApprovalRequired: () => true,
      approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'import-review' }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject', request: { ...request, status: 'rejected' } }),
    });
    await executor.execute(spec.id, raw, { surface: 'cli', authority: 'account_automation', serverId: 'home',
      actionCaller: { kind: 'host' }, actionRequestId: 'live-import-review', defaultSessionMachineId: 'machine-a' });
    expect(stored).toBeDefined();
    if (!stored) throw new Error('No live import approval was created');
    expect(stored.actionArgs).toEqual(spec.projectObservationInput!(raw));
    expect(JSON.stringify(stored)).not.toContain('private-secret-sentinel');
    const pending = describeApprovalRequestFields(stored);
    expect(JSON.stringify(pending)).toContain('issue-mcp');
    expect(JSON.stringify(pending)).toContain('team');
    expect(pending.unrepresentable).toBeNull();
    expect(describeApprovalRequestFields({ ...stored, status: 'rejected', actionArgs: settleApprovalRequestActionArgs(stored) })).toEqual(pending);
    // A durable observer without the originating waiter cannot execute even
    // though its safe presentation remains available.
    const retired = createActionExecutor({ approvalsGet: async () => ({ ...stored!, status: 'approved',
      decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 } }), approvalsUpdate: async () => ({ ok: true }) });
    const replay = await retired.replayApprovedApprovalRequest({ artifactId: 'import-review', callerAuthority: 'present_user' });
    expect(replay, JSON.stringify(replay))
      .toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable', details: { reason: 'live_invocation_unavailable' } });
  });
  it.each(cases)('%s preserves the reviewed operation privately and in settled history', (actionId, raw, expected) => {
    const spec = getActionSpec(actionId);
    const admitted = spec.inputSchema.parse(raw);
    const observed = spec.projectObservationInput!(admitted);
    const review = spec.approvalPresentation?.projectInput?.(admitted);
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId, actionArgs: spec.approvalInputCustody === 'live_only' ? observed : admitted,
      preview: { actionId, actionArgs: spec.approvalInputCustody === 'live_only' ? review ?? observed : observed }, summary: spec.title,
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'mcp-review',
        surface: 'cli', serverId: 'home', actionId } });
    const pending = describeApprovalActionFields({ actionId, actionArgs: admitted });
    for (const value of expected) expect(JSON.stringify(pending), actionId).toContain(value);
    expect(JSON.stringify(pending)).not.toContain('private-secret-sentinel');
    expect(JSON.stringify(observed)).not.toContain('issue-mcp');
    expect(resolveApprovalRequestApproveAdmission(request).status).toBe('available');
    expect(describeApprovalRequestFields(request)).toEqual(pending);
    const settled = { ...request, status: 'executed' as const, actionArgs: settleApprovalRequestActionArgs(request) };
    expect(JSON.stringify(settled.actionArgs)).not.toContain('private-secret-sentinel');
    expect(describeApprovalRequestFields(settled)).toEqual(pending);
    if (spec.approvalInputCustody === 'live_only') expect(settled.actionArgs).toEqual(observed);
  });

  it('types the target as an MCP server and refuses malformed review/replay inputs', () => {
    const fields = describeApprovalActionFields({ actionId: 'mcp.servers.tools.set', actionArgs: { serverId: 'mcp-a', tools: { delete_issue: 'allow' } } });
    expect(fields.rows).toContainEqual(expect.objectContaining({ title: 'MCP server', reference: { kind: 'mcpServer', id: 'mcp-a' } }));
    expect(describeApprovalActionFields({ actionId: 'mcp.servers.tools.set', actionArgs: { serverId: 'mcp-a', tools: { delete_issue: 'invalid' } } }).unrepresentable).not.toBeNull();
    const spec = getActionSpec('mcp.servers.import');
    const bad = describeApprovalRequestFields({ actionId: spec.id, actionArgs: {}, preview: { actionId: spec.id, actionArgs: { servers: [{ command: 42 }] } }, status: 'open' });
    expect(bad.unrepresentable).not.toBeNull();
  });
});
