import { readRecord } from '../../inputs/inputRecords.js';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 as inputs, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type McpServerActionIdV1 } from '../../mcp/servers/serverActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

function projectMcpObservation(input: unknown): unknown {
  const value = readRecord(input);
  const entry = readRecord(value.entry);
  const binding = readRecord(value.binding);
  return {
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.serverId === 'string' ? { serverId: value.serverId } : typeof entry.id === 'string' ? { serverId: entry.id } : {}),
    ...(Array.isArray(value.entries) ? { serverIds: value.entries
      .map(item => readRecord(readRecord(item).entry).id).filter(id => typeof id === 'string') } : {}),
    ...(typeof value.bindingId === 'string' ? { bindingId: value.bindingId } : typeof binding.id === 'string' ? { bindingId: binding.id } : {}),
    ...(typeof value.machineId === 'string' ? { machineId: value.machineId } : {}),
    ...(typeof value.expectedRevision === 'number' || value.expectedRevision === 'absent' ? { expectedRevision: value.expectedRevision } : {}),
    ...(typeof value.revision === 'number' || value.revision === 'absent' ? { revision: value.revision } : {}),
    ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
    ...(typeof value.toolCount === 'number' ? { toolCount: value.toolCount } : {}),
  };
}
function mcpSpec<TId extends McpServerActionIdV1>(id: TId, title: string, summary: string, options: Readonly<{
  read?: boolean; danger?: boolean; machine?: boolean;
}>): PreNormalizedActionSpec & Readonly<{ id: TId; inputSchema: (typeof inputs)[TId]; outputSchema: (typeof outputs)[TId] }> {
  return {
    id, title, safety: options.danger ? 'danger' : 'safe', sideEffectClass: options.read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: options.machine ? 'machine' : 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id], inputHints: { description: summary, fields: [] },
    projectObservationInput: projectMcpObservation, projectObservationOutput: projectMcpObservation,
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  };
}
export const MCP_SERVER_ACTION_SPECS_V1 = [
  mcpSpec('mcp.servers.list', 'List MCP servers',
    'See the MCP servers saved in your account.', { read: true }),
  mcpSpec('mcp.servers.read', 'Read MCP server',
    'See one MCP server: how it starts and where it is used.', { read: true }),
  mcpSpec('mcp.servers.create', 'Add MCP server',
    'Add an MCP server, which gives agents extra tools.', { danger: true }),
  mcpSpec('mcp.servers.update', 'Update MCP server',
    'Change how an MCP server starts or signs in.', { danger: true }),
  mcpSpec('mcp.servers.duplicate', 'Duplicate MCP server',
    'Make a copy of an MCP server to adjust.', { danger: true }),
  mcpSpec('mcp.servers.delete', 'Delete MCP server',
    'Remove an MCP server. Agents lose its tools everywhere it was used.', { danger: true }),
  mcpSpec('mcp.bindings.add', 'Use MCP server somewhere',
    'Make an MCP server available to agents in a place you choose, such as a machine or a project.', { danger: true }),
  mcpSpec('mcp.bindings.edit', 'Change where MCP server is used',
    'Change the place or the settings an MCP server is used with.', { danger: true }),
  mcpSpec('mcp.bindings.enable', 'Turn on MCP server somewhere',
    'Let agents use an MCP server again in one of the places it is set up.', { danger: true }),
  mcpSpec('mcp.bindings.disable', 'Turn off MCP server somewhere',
    'Stop agents using an MCP server in one place, keeping its setup.', {}),
  mcpSpec('mcp.bindings.remove', 'Stop using MCP server somewhere',
    'Remove an MCP server from one of the places it is used.', { danger: true }),
  mcpSpec('mcp.servers.test', 'Test MCP server connection',
    'Start an MCP server on a machine and check that it answers with its tools.', { danger: true, machine: true }),
  mcpSpec('mcp.servers.probe', 'Detect MCP servers on a machine',
    'Look for MCP servers already set up for the agents on a machine.', { read: true, machine: true }),
] as const satisfies readonly PreNormalizedActionSpec[];
