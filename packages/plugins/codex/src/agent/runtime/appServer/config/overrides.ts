import {
    ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES,
    resolveAcpToolPermissionPolicy,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
    createCodexInjectedMcpServerKey,
    isFirstPartyHappierMcpBridgeServerName,
} from '../../../mcp/serverKeys.js';

export type CodexAppServerMcpServerConfig = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
}>;

const CODEX_HAPPIER_MCP_STATIC_APPROVAL_TOOL_NAME_SET = new Set(
    ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES.filter((toolName) => (
        resolveAcpToolPermissionPolicy('plan')[toolName] === 'allow'
    )),
);

function quoteTomlString(value: string): string {
    return JSON.stringify(value);
}

function serializeTomlStringArray(values: readonly string[]): string {
    return `[${values.map((value) => quoteTomlString(value)).join(',')}]`;
}

function serializeTomlInlineTable(values: Readonly<Record<string, string>>): string {
    const entries = Object.entries(values)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${quoteTomlString(value)}`);
    return `{${entries.join(',')}}`;
}

function assignInjectedServerKeys(serverNames: readonly string[]): Map<string, string> {
    const assigned = new Map<string, string>();
    const usedKeys = new Set<string>();

    for (const serverName of [...serverNames].sort((left, right) => left.localeCompare(right))) {
        if ((serverName === 'happier' || serverName === 'happy') && !usedKeys.has(serverName)) {
            usedKeys.add(serverName);
            assigned.set(serverName, serverName);
            continue;
        }

        const baseKey = createCodexInjectedMcpServerKey(serverName);
        let candidate = baseKey;
        let suffix = 2;
        while (usedKeys.has(candidate)) {
            candidate = `${baseKey}_${suffix}`;
            suffix += 1;
        }
        usedKeys.add(candidate);
        assigned.set(serverName, candidate);
    }

    return assigned;
}

function appendHappierMcpStaticApprovalOverrides(overrides: string[], injectedKey: string): void {
    for (const toolName of ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES) {
        if (!CODEX_HAPPIER_MCP_STATIC_APPROVAL_TOOL_NAME_SET.has(toolName)) continue;
        overrides.push(`mcp_servers.${injectedKey}.tools.${toolName}.approval_mode=${quoteTomlString('approve')}`);
    }
}

export function buildCodexAppServerConfigOverrides(
    mcpServers: Readonly<Record<string, CodexAppServerMcpServerConfig>>,
): string[] {
    const serverNames = Object.keys(mcpServers);
    if (serverNames.length === 0) {
        return [];
    }

    const injectedKeys = assignInjectedServerKeys(serverNames);
    const overrides: string[] = [];

    for (const serverName of [...serverNames].sort((left, right) => left.localeCompare(right))) {
        const config = mcpServers[serverName];
        const injectedKey = injectedKeys.get(serverName);
        if (!injectedKey) continue;

        overrides.push(`mcp_servers.${injectedKey}.command=${quoteTomlString(config.command)}`);
        if (Array.isArray(config.args) && config.args.length > 0) {
            overrides.push(`mcp_servers.${injectedKey}.args=${serializeTomlStringArray(config.args)}`);
        }
        if (config.env && Object.keys(config.env).length > 0) {
            overrides.push(`mcp_servers.${injectedKey}.env=${serializeTomlInlineTable(config.env)}`);
        }
        overrides.push(`mcp_servers.${injectedKey}.enabled=true`);
        if (isFirstPartyHappierMcpBridgeServerName(serverName)) {
            appendHappierMcpStaticApprovalOverrides(overrides, injectedKey);
        }
    }

    return overrides;
}
