export const MCP_SERVER_TOOLS_SET_ACTION_ID_V1 = 'mcp.servers.tools.set';

export const MCP_SERVER_ACTION_IDS_V1 = [
  'mcp.servers.list', 'mcp.servers.read', 'mcp.servers.create', 'mcp.servers.update',
  'mcp.servers.duplicate', 'mcp.servers.delete', 'mcp.servers.test', 'mcp.found.list', 'mcp.found.adopt', 'mcp.servers.import',
  'mcp.servers.signIn.start',
  'mcp.servers.tools.list',
  MCP_SERVER_TOOLS_SET_ACTION_ID_V1,
] as const;
export type McpServerActionIdV1 = typeof MCP_SERVER_ACTION_IDS_V1[number];
export function isMcpServerActionIdV1(value: string): value is McpServerActionIdV1 {
  return (MCP_SERVER_ACTION_IDS_V1 as readonly string[]).includes(value);
}
