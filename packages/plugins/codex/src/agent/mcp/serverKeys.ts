const CODEX_MCP_KEY_SEPARATOR = '__';
const CODEX_HAPPIER_INJECTED_MCP_SERVER_KEY_PREFIX = `happier${CODEX_MCP_KEY_SEPARATOR}`;

export function isFirstPartyHappierMcpBridgeServerName(serverName: string): boolean {
    return serverName === 'happier' || serverName === 'happy';
}

export function sanitizeCodexInjectedMcpServerKeyFragment(name: string): string {
    const normalized = name
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized.length > 0 ? normalized : 'server';
}

export function createCodexInjectedMcpServerKey(serverName: string): string {
    return `${CODEX_HAPPIER_INJECTED_MCP_SERVER_KEY_PREFIX}${sanitizeCodexInjectedMcpServerKeyFragment(serverName)}`;
}

export function normalizeCodexMcpServerName(serverName: string): string {
    const normalized = serverName.trim();
    if (normalized === `${CODEX_HAPPIER_INJECTED_MCP_SERVER_KEY_PREFIX}happier`) return 'happier';
    return normalized;
}
