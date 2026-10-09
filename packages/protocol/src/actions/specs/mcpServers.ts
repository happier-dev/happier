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
    ...(typeof value.bindingId === 'string' ? { bindingId: value.bindingId } : typeof binding.id === 'string' ? { bindingId: binding.id } : {}),
    ...(typeof value.machineId === 'string' ? { machineId: value.machineId } : {}),
    ...(typeof value.expectedRevision === 'number' || value.expectedRevision === 'absent' ? { expectedRevision: value.expectedRevision } : {}),
    ...(typeof value.revision === 'number' || value.revision === 'absent' ? { revision: value.revision } : {}),
    ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
    ...(typeof value.toolCount === 'number' ? { toolCount: value.toolCount } : {}),
  };
}
function mcpSpec<TId extends McpServerActionIdV1>(id: TId, title: string, options: Readonly<{
  read?: boolean; danger?: boolean; machine?: boolean;
}>): PreNormalizedActionSpec & Readonly<{ id: TId; inputSchema: (typeof inputs)[TId]; outputSchema: (typeof outputs)[TId] }> {
  return {
    id, title, safety: options.danger ? 'danger' : 'safe', sideEffectClass: options.read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: options.machine ? 'machine' : 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id], inputHints: { fields: [] },
    projectObservationInput: projectMcpObservation, projectObservationOutput: projectMcpObservation,
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  };
}
export const MCP_SERVER_ACTION_SPECS_V1 = [
  mcpSpec('mcp.servers.list', 'List MCP servers', { read: true }),
  mcpSpec('mcp.servers.read', 'Read MCP server', { read: true }),
  mcpSpec('mcp.servers.create', 'Create MCP server', { danger: true }),
  mcpSpec('mcp.servers.update', 'Update MCP server', { danger: true }),
  mcpSpec('mcp.servers.duplicate', 'Duplicate MCP server', { danger: true }),
  mcpSpec('mcp.servers.delete', 'Delete MCP server', { danger: true }),
  mcpSpec('mcp.bindings.add', 'Add MCP binding', { danger: true }),
  mcpSpec('mcp.bindings.edit', 'Edit MCP binding', { danger: true }),
  mcpSpec('mcp.bindings.enable', 'Enable MCP binding', { danger: true }),
  mcpSpec('mcp.bindings.disable', 'Disable MCP binding', {}),
  mcpSpec('mcp.bindings.remove', 'Remove MCP binding', { danger: true }),
  mcpSpec('mcp.servers.test', 'Test MCP server connection', { danger: true, machine: true }),
  mcpSpec('mcp.servers.probe', 'Detect MCP servers on a machine', { read: true, machine: true }),
] as const satisfies readonly PreNormalizedActionSpec[];
