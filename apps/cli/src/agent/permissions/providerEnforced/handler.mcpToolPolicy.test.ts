import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerToolPolicyV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ServerBoundPermissionRpcHandlerManager } from '../testkit/serverBoundPermissionRpcHandlerManager';
import { ProviderEnforcedPermissionHandler } from './handler';
import { createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';

function catalog(policy: McpServerToolPolicyV1): McpServerCatalogSnapshotV1 {
  return { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog: { v: 1,
    servers: [{ id: 'catalog-id', name: 'docs', title: 'Team docs', transport: 'stdio', stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1, tools: policy,
      toolsSnapshot: { checkedAt: 1, machineId: 'machine', tools: [{ name: 'read_page', title: 'Read page', annotations: { readOnlyHint: true }, tokens: 1 }] } }], bindings: [] } };
}
afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
function fixture(policy: McpServerToolPolicyV1) {
  setActiveAccountSettingsSnapshot({ scopeKey: 'mcp-policy-account', source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], rawSettings: {}, promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  const session = createMutableApiSessionClientFixture({ sessionId: 'mcp-policy-session' });
  const rpcHandlers = new ServerBoundPermissionRpcHandlerManager(session.sessionId);
  // The authenticated server stamps permission-response RPC authority.
  vi.spyOn(session.rpcHandlerManager, 'registerHandler').mockImplementation((name, handler) => rpcHandlers.registerHandler(name, handler));
  let current = catalog(policy);
  const getMcpToolContext = () => ({ catalog: current, mcpServerIdentities: { docs: { serverId: 'catalog-id', serverTitle: 'Team docs' } } });
  const handler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[MCP policy]', getWorkspaceWrites: () => 'allow', getMcpToolContext });
  return { session, handler, getMcpToolContext, change(next: McpServerToolPolicyV1) { current = catalog(next); },
    async answer(id: string, fields: Record<string, unknown> = {}) { await rpcHandlers.handlers.get('permission')?.({ id, approved: true, ...fields }); } };
}
describe('live MCP policy at the session permission owner', () => {
  it('Off beats full access and an existing session grant', async () => {
    const f = fixture({ default: 'ask', overrides: {} });
    const first = f.handler.handleToolCall('first', 'mcp__docs__read_page', {});
    await f.answer('first', { allowedTools: ['mcp__docs__read_page'] });
    await first;
    f.change({ default: 'allow_all', overrides: { read_page: 'off' } });
    f.handler.setPermissionMode('yolo');
    await expect(f.handler.handleToolCall('second', 'mcp__docs__read_page', {})).resolves.toEqual({ decision: 'denied', rationale: 'permission_denied' });
  });
  it('Allow approves without a card and a subsequent Ask edit publishes resolved catalog identity', async () => {
    const f = fixture({ default: 'ask', overrides: { read_page: 'allow' } });
    await expect(f.handler.handleToolCall('allowed', 'mcp__docs__read_page', {})).resolves.toMatchObject({ decision: 'approved' });
    expect(f.session.__getAgentState().requests?.allowed).toBeUndefined();
    f.change({ default: 'allow_read_only', overrides: { read_page: 'ask' } });
    const pending = f.handler.handleToolCall('ask', 'mcp__docs__read_page', {});
    expect(f.session.__getAgentState().requests?.ask).toMatchObject({ mcpTool: { server: 'docs', tool: 'read_page', item: { serverId: 'catalog-id' }, serverTitle: 'Team docs', toolTitle: 'Read page', decision: { approval: 'ask', effectClass: 'read' } } });
    await f.answer('ask'); await pending;
  });
  it('rereads Off at answer time and never applies the pending Allow', async () => {
    const f = fixture({ default: 'ask', overrides: {} });
    const pending = f.handler.handleToolCall('pending', 'mcp__docs__read_page', {});
    f.change({ default: 'ask', overrides: { read_page: 'off' } });
    await f.answer('pending');
    await expect(pending).resolves.toMatchObject({ decision: 'denied' });
  });
  it('read-only denies an annotated tool unless the server has opted into read classification', () => {
    const f = fixture({ default: 'ask', overrides: { read_page: 'allow' } });
    f.handler.setPermissionMode('read-only');
    expect(f.handler.getImmediateDecision('restricted', 'mcp__docs__read_page', {})).toEqual({ decision: 'denied', rationale: 'permission_exceeds_ceiling' });
    f.change({ default: 'allow_read_only', overrides: {} });
    expect(f.handler.getImmediateDecision('read', 'mcp__docs__read_page', {})).toEqual({ decision: 'approved' });
  });
  it('an attached child Ask does not inherit parent yolo but retains explicit parent grants and ceilings', async () => {
    const f = fixture({ default: 'ask', overrides: {} });
    f.handler.setPermissionMode('yolo');
    const run = createRunScopedExecutionPermissionHandler({ runId: 'child', controllerOccurrenceId: 'child-occurrence', handler: f.handler,
      mcpToolPolicy: { permissionMode: 'default', readContext: f.getMcpToolContext } });
    expect(run.handler.getImmediateDecision?.('ask', 'mcp__docs__read_page', {})).toBeNull();
    const pending = run.handler.handleToolCall('ask', 'mcp__docs__read_page', {});
    const requestId = Object.keys(f.session.__getAgentState().requests ?? {})[0]!;
    await f.answer(requestId, { allowedTools: ['mcp__docs__read_page'] });
    await pending;
    await expect(run.handler.handleToolCall('granted', 'mcp__docs__read_page', {})).resolves.toMatchObject({ decision: 'approved_for_session' });
    f.handler.setPermissionMode('read-only');
    const broader = createRunScopedExecutionPermissionHandler({ runId: 'broader', controllerOccurrenceId: 'broader-occurrence', handler: f.handler,
      mcpToolPolicy: { permissionMode: 'yolo', readContext: f.getMcpToolContext } });
    expect(broader.handler.getImmediateDecision?.('restricted', 'mcp__docs__read_page', {})).toEqual({ decision: 'denied', rationale: 'permission_exceeds_ceiling' });
    f.handler.setPermissionMode('yolo');
    expect(broader.handler.getImmediateDecision?.('lost-authority', 'mcp__docs__read_page', {}, { causalPermissionAuthority: null })).toEqual({ decision: 'denied', rationale: 'causal_permission_authority_invalid' });
    await run.dispose('test completed'); await broader.dispose('test completed');
  });
});
