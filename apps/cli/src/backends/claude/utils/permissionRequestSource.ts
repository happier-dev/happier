export const CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = 'claude_local_permission_bridge' as const;

export function isClaudeLocalPermissionBridgeAgentStateRequest(request: unknown): boolean {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return false;
  }

  return (request as { source?: unknown }).source === CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE;
}
