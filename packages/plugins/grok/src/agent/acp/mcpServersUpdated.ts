import type { AgentAcpExtensionContext } from '@happier-dev/plugin-sdk/agent-runtime';

export const GROK_MCP_SERVERS_UPDATED_METHOD = '_x.ai/mcp/servers_updated' as const;

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Grok MCP server update notification: ${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalBoundedString(value: unknown, maxLength: number, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
    throw new Error(`Invalid Grok MCP server update notification: ${label} must be a bounded string`);
  }
}

export function handleGrokMcpServersUpdated(
  params: unknown,
  context: Pick<AgentAcpExtensionContext, 'method'>,
): void {
  if (context.method !== GROK_MCP_SERVERS_UPDATED_METHOD) {
    throw new Error('Unsupported Grok MCP server update notification method');
  }
  const payload = asRecord(params, 'payload');
  if (Object.keys(payload).some((key) => key !== 'mcpServers')) {
    throw new Error('Invalid Grok MCP server update notification: unsupported payload field');
  }
  if (!Array.isArray(payload.mcpServers) || payload.mcpServers.length > 128) {
    throw new Error('Invalid Grok MCP server update notification: mcpServers must be a bounded array');
  }
  for (const rawServer of payload.mcpServers) {
    const server = asRecord(rawServer, 'server');
    if (
      typeof server.name !== 'string'
      || server.name.length === 0
      || server.name.length > 512
      || server.name !== server.name.trim()
    ) throw new Error('Invalid Grok MCP server update notification: server name must be exact');
    optionalBoundedString(server.source, 512, 'source');
    optionalBoundedString(server.type, 128, 'type');
    optionalBoundedString(server.command, 16_384, 'command');
    if (server.args !== undefined) {
      if (!Array.isArray(server.args) || server.args.length > 128) {
        throw new Error('Invalid Grok MCP server update notification: args must be a bounded array');
      }
      for (const arg of server.args) optionalBoundedString(arg, 16_384, 'arg');
    }
  }
  // Status-only acknowledgement. session/new remains the sole owner of host MCP state.
}
