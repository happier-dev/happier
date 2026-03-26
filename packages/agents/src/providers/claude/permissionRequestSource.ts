export const CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = 'claude_local_permission_bridge' as const;

type ClaudeLocalPermissionBridgeAgentStateRequest = Readonly<{
    source: typeof CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE;
}>;

export function isClaudeLocalPermissionBridgeAgentStateRequest(
    request: unknown,
): request is ClaudeLocalPermissionBridgeAgentStateRequest {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return false;
    }

    return (request as { source?: unknown }).source === CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE;
}
