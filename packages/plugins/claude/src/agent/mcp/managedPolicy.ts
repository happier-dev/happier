import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

const conflictCode = 'claude_managed_mcp_policy_conflict';
export const CLAUDE_MCP_CONFIG_UNAVAILABLE_CODE = 'plugin_mcp_preparation_unavailable';
export type ClaudeMcpStartupFailureCode = typeof conflictCode | typeof CLAUDE_MCP_CONFIG_UNAVAILABLE_CODE;

export function readClaudeMcpStartupFailure(error: unknown): Readonly<{
    code: ClaudeMcpStartupFailureCode;
    retryable: boolean;
}> | undefined {
    if (!isPluginError(error) || (error.code !== conflictCode && error.code !== CLAUDE_MCP_CONFIG_UNAVAILABLE_CODE)) return undefined;
    return { code: error.code, retryable: error.retryable };
}

export function createClaudeMcpConfigUnavailableError() {
    return new PluginError({ code: CLAUDE_MCP_CONFIG_UNAVAILABLE_CODE, message: 'Claude could not read its MCP configuration file.' });
}

export function createClaudeManagedMcpPolicyConflictError() {
    return new PluginError({ code: conflictCode, retryable: false,
        message: 'Claude organization policy prevents the requested MCP configuration or isolation. Ask your administrator to provide a compatible policy; Happier will not weaken the requested restriction.' });
}

