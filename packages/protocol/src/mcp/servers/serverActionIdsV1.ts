export const MCP_SERVER_ACTION_IDS_V1 = [
  'mcp.servers.list', 'mcp.servers.read', 'mcp.servers.create', 'mcp.servers.update',
  'mcp.servers.duplicate', 'mcp.servers.delete', 'mcp.bindings.add', 'mcp.bindings.edit',
  'mcp.bindings.enable', 'mcp.bindings.disable', 'mcp.bindings.remove', 'mcp.servers.test', 'mcp.servers.probe',
] as const;
export type McpServerActionIdV1 = typeof MCP_SERVER_ACTION_IDS_V1[number];
export function isMcpServerActionIdV1(value: string): value is McpServerActionIdV1 {
  return (MCP_SERVER_ACTION_IDS_V1 as readonly string[]).includes(value);
}
