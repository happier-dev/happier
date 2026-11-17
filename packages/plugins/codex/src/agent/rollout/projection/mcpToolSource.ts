import { formatMcpToolWireNameV1, parseMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
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
    // Historical rollouts have no launch inventory. Their injected namespace
    // ends at the last separator; this is a read-only legacy format adapter.
    const legacyKey = normalized.startsWith('mcp__happier__')
        ? normalized.slice(5, normalized.lastIndexOf('__')) : null;
    const identity = parseMcpToolWireNameV1(normalized,
        legacyKey && legacyKey !== 'happier' ? new Set([legacyKey]) : undefined);
    return identity ? { serverName: normalizeCodexMcpServerName(identity.server), toolName: identity.tool } : null;
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
        return formatMcpToolWireNameV1('happier', normalized.slice(happierPrefix.length));
    }
    return normalized;
}

export function formatCodexMcpToolSource(source: CodexRolloutToolSource): string {
    return normalizeCodexMcpToolName(formatMcpToolWireNameV1(source.serverName, source.toolName));
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
