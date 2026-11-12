import { expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { registerHappierMcpBuiltInTools, prepareHappierMcpToolInventory } from './registerHappierMcpBuiltInTools';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';

it.each([
  { surface: 'agent', mode: 'generic' }, { surface: 'mcp', mode: 'generic' },
  { surface: 'agent', mode: 'direct' }, { surface: 'mcp', mode: 'direct' },
] as const)('returns an admitted operation over $surface $mode MCP and keeps later calls usable', async ({ surface, mode }) => {
  const runtime = createHostActionOperationRuntime({ machineId: 'machine', serverId: 'home',
    resolveAccountId: async () => 'account', generateOperationId: () => 'long-operation' });
  let finish!: () => void;
  const effect = new Promise<void>(resolve => { finish = resolve; });
  const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
    'machines.reboot': { toolExposureModes: { agent: 'direct', mcp: 'direct' } },
  } });
  // Target daemon transport is the effect boundary. MCP, admission, operation
  // custody, output settlement and operation reads remain real.
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    runActionOperation: runtime.runActionOperation,
    machineReboot: async () => { await effect; return { kind: 'blocked' as const, reasons: ['setup'] }; },
    actionOperationAction: args => executeActionOperationActionV1({ ...args, transport: async request =>
      runtime.handlers.getV2(request.payload) }),
  });
  const bridge = createActionToolExecutorBridge({ surface, actionsSettings: settings, executor: { execute: (id, input, context) =>
    executor.execute(id, input, { ...context, serverId: 'home', runtimeAccountId: 'account', bypassApprovals: true }) } });
  const requiredDirectActionIds = ['machines.reboot'] as const;
  const catalog = createHappierToolInventory({ surface, actionsSettings: settings, requiredDirectActionIds });
  const directTool = catalog.tools.find(tool => tool.actionId === 'machines.reboot');
  if (!directTool) throw new Error('Missing declared reboot MCP tool');
  const server = new McpServer({ name: 'long-operations', version: '1' });
  registerHappierMcpBuiltInTools(server, { sessionId: 'caller', surface, actionsSettings: settings, requiredDirectActionIds,
    toolInventory: prepareHappierMcpToolInventory({ sessionId: 'caller', inventory: {
      ...catalog, tools: catalog.tools.filter(tool => tool.name === 'action_execute' || tool === directTool),
    } }), deps: { ...bridge, changeTitle: async () => ({ success: true }),
      resolveActionOptions: args => bridge.resolveActionOptions(args, 'caller') } });
  const client = new Client({ name: 'long-operations-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (actionId: string, input: Record<string, unknown>) => {
    const result = await client.callTool(mode === 'direct' && actionId === 'machines.reboot'
      ? { name: directTool.name, arguments: input }
      : { name: 'action_execute', arguments: { actionId, input } });
    expect(result.isError).toBe(false);
    const content = result.content;
    if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Missing Action result');
    return JSON.parse(content[0].text);
  };
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    // The effect cannot complete until after this response: no timer simulates duration.
    expect(await call('machines.reboot', { serverId: 'home', machineId: 'machine', expectedInstallationId: 'installation' }))
      .toMatchObject({ operationId: 'long-operation', status: 'accepted' });
    const input = { serverId: 'home', machineId: 'machine', operationId: 'long-operation' };
    expect(await call('action.operations.get', input)).toMatchObject({ kind: 'found', operation: { state: 'running' } });
    finish();
    await runtime.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'long-operation');
    expect(await call('action.operations.get', input)).toMatchObject({ kind: 'found', operation: { state: 'failed' } });
    expect(await call('action.operations.get', { ...input, operationId: 'absent' })).toMatchObject({ kind: 'not_found' });
  } finally { finish(); await client.close(); await server.close(); }
});


it.each(['agent', 'mcp'] as const)('returns durable approval custody over %s without waiting for a person', async surface => {
  let stored: ApprovalRequest | null = null;
  let effects = 0;
  const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
    'session.title.set': { approvalRequiredSurfaces: [surface] },
  } });
  // The private Artifact store and Session transport are system boundaries.
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'durable-approval' }; },
    approvalsGet: async () => stored,
    sessionStateFieldSet: async () => { effects++; return { ok: true }; },
  });
  const bridge = createActionToolExecutorBridge({ surface, actionsSettings: settings,
    executor: { execute: (id, input, context) => executor.execute(id, input, {
      ...context, serverId: 'home', runtimeAccountId: 'account', actionsSettings: settings,
    }) } });
  const catalog = createHappierToolInventory({ surface, actionsSettings: settings });
  const server = new McpServer({ name: 'durable-approval', version: '1' });
  registerHappierMcpBuiltInTools(server, { sessionId: 'caller', surface, actionsSettings: settings,
    toolInventory: prepareHappierMcpToolInventory({ sessionId: 'caller', inventory: {
      ...catalog, tools: catalog.tools.filter(tool => tool.name === 'action_execute'),
    } }), deps: { ...bridge, changeTitle: async () => ({ success: true }),
      resolveActionOptions: args => bridge.resolveActionOptions(args, 'caller') } });
  const client = new Client({ name: 'durable-approval-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (actionId: string, input: unknown) => {
    const result = await client.callTool({ name: 'action_execute', arguments: { actionId, input } });
    expect(result.isError).toBe(false);
    const content = result.content;
    if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Missing Action result');
    return JSON.parse(content[0].text);
  };
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    expect(await call('session.title.set', { sessionId: 'caller', title: 'Reviewed title' }))
      .toMatchObject({ kind: 'approval_request_created', artifactId: 'durable-approval', actionId: 'session.title.set' });
    expect(effects).toBe(0);
    expect(await call('approval.request.get', { artifactId: 'durable-approval' }))
      .toMatchObject({ request: { status: 'open', approval: { flow: 'deferred' } } });
    expect(effects).toBe(0);
  } finally { await client.close(); await server.close(); }
});
