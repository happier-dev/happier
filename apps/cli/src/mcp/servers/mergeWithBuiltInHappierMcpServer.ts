import type { McpServerConfig } from '@/agent';

/**
 * Ensures the built-in `happier` MCP server is always present and wins collisions.
 */
export function mergeWithBuiltInHappierMcpServer(params: Readonly<{
  builtIn: Record<string, McpServerConfig>;
  extra: Record<string, McpServerConfig>;
}>): Record<string, McpServerConfig> {
  const { happier, ...restBuiltIn } = params.builtIn;
  const { happier: _ignoredUserHappier, ...restExtra } = params.extra;
  return {
    ...restExtra,
    ...restBuiltIn,
    ...(happier ? { happier } : {}),
  };
}

