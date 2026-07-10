import { normalizeCodexMcpServerName } from '../../mcp/serverKeys.js';

export type CodexRolloutToolSource = Readonly<{
    kind: 'mcp';
    serverName: string;
    toolName: string;
}>;

function readStringField(record: Readonly<Record<string, unknown>>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
    const normalized = name.trim();
    const prefix = 'mcp__';
    if (!normalized.startsWith(prefix)) return null;

    const parts = normalized.slice(prefix.length).split('__');
    if (parts.length < 2 || parts.some((part) => part.trim().length === 0)) return null;

    if (parts[0] === 'happier' && parts.length >= 3) {
        const serverParts = parts.length > 3 ? parts.slice(0, -1) : parts.slice(0, 2);
        return {
            serverName: normalizeCodexMcpServerName(serverParts.join('__')),
            toolName: parts.slice(serverParts.length).join('__'),
        };
    }

    return {
        serverName: normalizeCodexMcpServerName(parts[0]),
        toolName: parts.slice(1).join('__'),
    };
}

function parseMcpNamespace(namespace: string): string | null {
    const normalized = namespace.trim();
    if (!normalized.startsWith('mcp__')) return null;
    const serverName = normalized.slice('mcp__'.length).trim();
    return serverName.length > 0 ? serverName : null;
}

export function normalizeCodexMcpToolName(name: string): string {
    const normalized = name.trim();
    const happierPrefix = 'mcp__happier__happier__';
    if (normalized.startsWith(happierPrefix)) {
        return `mcp__happier__${normalized.slice(happierPrefix.length)}`;
    }
    return normalized;
}

export function formatCodexMcpToolSource(source: CodexRolloutToolSource): string {
    return normalizeCodexMcpToolName(`mcp__${source.serverName}__${source.toolName}`);
}

export function readCodexMcpToolSource(
    payload: Readonly<Record<string, unknown>>,
    name: string,
): CodexRolloutToolSource | undefined {
    const parsedName = parseMcpToolName(name);
    const namespaceServerName = (() => {
        const namespace = readStringField(payload, 'namespace');
        return namespace ? parseMcpNamespace(namespace) : null;
    })();
    const rawServerName =
        readStringField(payload, 'server')
        ?? readStringField(payload, 'mcpServer')
        ?? readStringField(payload, 'mcp_server')
        ?? readStringField(payload, 'serverName')
        ?? readStringField(payload, 'server_name')
        ?? parsedName?.serverName
        ?? namespaceServerName
        ?? null;
    if (!rawServerName) return undefined;

    const toolName =
        readStringField(payload, 'tool')
        ?? readStringField(payload, 'toolName')
        ?? readStringField(payload, 'tool_name')
        ?? parsedName?.toolName
        ?? readStringField(payload, 'name');
    if (!toolName) return undefined;

    return {
        kind: 'mcp',
        serverName: normalizeCodexMcpServerName(rawServerName),
        toolName,
    };
}
