import type { McpServerConfig } from '@/agent';

/**
 * Reserves the `happier` name for the built-in server, when enabled.
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

