const BUILTIN_HAPPIER_MCP_SERVER_PREFIX = 'mcp__happier__happier__';

export function canonicalizeCodexMcpToolName(toolName: string): string {
    const normalized = typeof toolName === 'string' ? toolName.trim() : '';
    if (!normalized) return normalized;
    if (!normalized.startsWith(BUILTIN_HAPPIER_MCP_SERVER_PREFIX)) return normalized;
    return `mcp__happier__${normalized.slice(BUILTIN_HAPPIER_MCP_SERVER_PREFIX.length)}`;
}
