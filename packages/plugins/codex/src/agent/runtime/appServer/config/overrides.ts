import { listHappierToolAutoApprovedNamesV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentSessionConfigurationSnapshot, AgentSessionMcpToolPolicy, AgentSessionOpenRequest, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
    createCodexInjectedMcpServerKey,
    isFirstPartyHappierMcpBridgeServerName,
} from '../../../mcp/serverKeys.js';
import { readCodexAppServerStartupRpcTimeoutMs } from '../client/timeout.js';
import { resolveCodexTerminalPermissionPolicy } from '../../terminal/permissionPolicy.js';

export type CodexAppServerMcpServerConfig = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    enabledTools?: readonly string[];
}>;

type CodexToolRestrictionConfiguration = Pick<AgentSessionConfigurationSnapshot, 'allowedTools' | 'unlistedTools'>;

export function resolveCodexHostFunctionNamespace(configuration?: CodexToolRestrictionConfiguration): string | null {
    // Restricted recipes exclude native `functions` (including MCP resource readers).
    // Otherwise advertise flat functions: OpenAI-compatible providers can flatten a
    // custom namespace into a dotted name that Codex cannot dispatch.
    return configuration?.unlistedTools === 'deny' ? 'happier_host' : null;
}

export function listCodexAppServerMcpServerNames(
    mcpServers: Readonly<Record<string, CodexAppServerMcpServerConfig>>,
    configuration?: CodexToolRestrictionConfiguration,
): string[] {
    return configuration?.unlistedTools === 'deny' && configuration.allowedTools?.length === 0
        ? [] : Object.keys(mcpServers);
}

export function buildCodexUnlistedToolConfigOverrides(configuration?: CodexToolRestrictionConfiguration): string[] {
    if (configuration?.unlistedTools !== 'deny') return [];
    const policy = resolveCodexTerminalPermissionPolicy('default', undefined, configuration.unlistedTools);
    // Native tools can bypass Happier approval callbacks. Remove their capability
    // at launch; the host's canonical matcher supplies each MCP enabledTools list.
    // Keep code-mode host available for listed MCP tools, but exclude the native
    // functions namespace, which includes MCP resource readers outside enabled_tools.
    return [
        'features.shell_tool=false',
        'features.view_image=false',
        'features.apps=false',
        'features.plugins=false',
        'features.multi_agent=false',
        'features.multi_agent_v2=false',
        'features.browser_use=false',
        'features.browser_use_external=false',
        'features.computer_use=false',
        'features.code_mode.enabled=false',
        'features.code_mode.excluded_tool_namespaces=["functions"]',
        'features.image_generation=false',
        'features.hooks=false',
        'features.workspace_dependencies=false',
        `approval_policy=${quoteTomlString(policy.approvalPolicy)}`,
        `sandbox_mode=${quoteTomlString(policy.sandbox)}`,
        `web_search=${quoteTomlString(configuration.allowedTools?.some((tool) => tool.toLowerCase() === 'websearch') ? 'cached' : 'disabled')}`,
    ];
}

const MAX_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS = 2_147_000_000;
// Happier execution waits may omit their deadline, but Codex requires a fixed positive
// tool_timeout_sec. Use the Node-safe maximum (~24.8 days) as the closest supported outer
// safety ceiling; this intentionally approximates rather than claims to be an unbounded wait.
const DEFAULT_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS = MAX_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS;
const MIN_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

function readCodexHappierMcpToolCallTimeoutMs(
    processEnv: Readonly<Record<string, string | undefined>> | undefined,
): number {
    const parsed = Number.parseInt(
        String(processEnv?.HAPPIER_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS ?? '').trim(),
        10,
    );
    if (!Number.isFinite(parsed) || parsed < MIN_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS) {
        return DEFAULT_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS;
    }
    return Math.min(parsed, MAX_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS);
}

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

export function assignInjectedServerKeys(serverNames: readonly string[]): Map<string, string> {
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
    for (const toolName of listHappierToolAutoApprovedNamesV1()) {
        overrides.push(`mcp_servers.${injectedKey}.tools.${toolName}.approval_mode=${quoteTomlString('approve')}`);
    }
}

export function buildCodexAppServerConfigOverrides(
    mcpServers: Readonly<Record<string, CodexAppServerMcpServerConfig>>,
    options: Readonly<{
        processEnv?: Readonly<Record<string, string | undefined>>;
        skills?: AgentSessionSkillDelivery;
        functionTools?: AgentSessionOpenRequest['functionTools'];
        mcpToolPolicy?: Readonly<Record<string, AgentSessionMcpToolPolicy>>;
    }> & CodexToolRestrictionConfiguration = {},
): string[] {
    const serverNames = listCodexAppServerMcpServerNames(mcpServers, options);
    const injectedKeys = assignInjectedServerKeys(serverNames);
    const overrides = buildCodexUnlistedToolConfigOverrides(options);
    // Code-mode-only models hide ordinary dynamic functions from the direct
    // catalog. Host callbacks must stay callable independently of native policy.
    if (options.functionTools?.length || options.unlistedTools === 'deny') {
        overrides.push(`features.code_mode.direct_only_tool_namespaces=[${quoteTomlString(resolveCodexHostFunctionNamespace(options) ?? 'functions')}]`);
    }
    if (options.skills?.nativeDisables.length) {
        const disables = options.skills.nativeDisables.map(({ path }) => `{path=${quoteTomlString(path)},enabled=false}`);
        overrides.push(`skills.config=[${disables.join(',')}]`);
    }

    // Codex fully awaits a required server before the first turn and fails thread/start
    // when it cannot initialize. Optional servers only get Codex's own short grace, so
    // a slow or hung third-party server joins later instead of holding the first turn.
    const happierMcpStartupTimeoutMs = readCodexAppServerStartupRpcTimeoutMs(options.processEnv ?? {});
    if (serverNames.some(name => !isFirstPartyHappierMcpBridgeServerName(name) && options.mcpToolPolicy?.[name])) {
        // Codex 0.162.1's tool-approval elicitation contains a human title but
        // no tool id or call id. Its requestUserInput path carries itemId and
        // reaches the existing canonical MCP correlation/host permission codec.
        overrides.push('features.tool_call_mcp_elicitation=false');
    }

    for (const serverName of [...serverNames].sort((left, right) => left.localeCompare(right))) {
        const config = mcpServers[serverName];
        const injectedKey = injectedKeys.get(serverName);
        if (!injectedKey) continue;
        if (options.unlistedTools === 'deny' && !Array.isArray(config.enabledTools)) {
            throw new PluginError({
                code: 'codex_tool_restriction_catalog_unavailable',
                message: 'Codex tool restriction requires the host-filtered MCP tool catalog.',
            });
        }

        overrides.push(`mcp_servers.${injectedKey}.command=${quoteTomlString(config.command)}`);
        if (Array.isArray(config.args) && config.args.length > 0) {
            overrides.push(`mcp_servers.${injectedKey}.args=${serializeTomlStringArray(config.args)}`);
        }
        if (config.env && Object.keys(config.env).length > 0) {
            overrides.push(`mcp_servers.${injectedKey}.env=${serializeTomlInlineTable(config.env)}`);
        }
        overrides.push(`mcp_servers.${injectedKey}.enabled=true`);
        if (isFirstPartyHappierMcpBridgeServerName(serverName)) {
            overrides.push(`mcp_servers.${injectedKey}.required=true`);
            overrides.push(`mcp_servers.${injectedKey}.startup_timeout_sec=${happierMcpStartupTimeoutMs / 1_000}`);
        }
        const policy = isFirstPartyHappierMcpBridgeServerName(serverName) ? undefined : options.mcpToolPolicy?.[serverName];
        const disabledTools = policy ? Object.entries(policy.tools)
            .filter(([, setting]) => setting === 'off' || setting === 'deny').map(([tool]) => tool) : [];
        const enabledTools = config.enabledTools
            ? config.enabledTools.filter(tool => !disabledTools.includes(tool))
            : policy?.unlisted === 'deny' ? Object.entries(policy.tools)
                .filter(([, setting]) => setting === 'ask' || setting === 'allow').map(([tool]) => tool) : undefined;
        if (enabledTools) {
            overrides.push(`mcp_servers.${injectedKey}.enabled_tools=${serializeTomlStringArray(enabledTools)}`);
        }
        if (policy) {
            if (disabledTools.length) overrides.push(`mcp_servers.${injectedKey}.disabled_tools=${serializeTomlStringArray(disabledTools)}`);
            // Native Runs have no live configuration setter. Even Allow must
            // ask the existing host handler rather than bypass revocation.
            overrides.push(`mcp_servers.${injectedKey}.default_tools_approval_mode=${quoteTomlString('prompt')}`);
            for (const [tool, setting] of Object.entries(policy.tools)) {
                if (setting === 'ask' || setting === 'allow') {
                    overrides.push(`mcp_servers.${injectedKey}.tools.${quoteTomlString(tool)}.approval_mode=${quoteTomlString('prompt')}`);
                }
            }
        } else if (config.enabledTools) {
            overrides.push(`mcp_servers.${injectedKey}.default_tools_approval_mode=${quoteTomlString('approve')}`);
        }
        if (isFirstPartyHappierMcpBridgeServerName(serverName)) {
            const timeoutMs = readCodexHappierMcpToolCallTimeoutMs(options.processEnv);
            overrides.push(`mcp_servers.${injectedKey}.tool_timeout_sec=${timeoutMs / 1_000}`);
            appendHappierMcpStaticApprovalOverrides(overrides, injectedKey);
        }
    }

    return overrides;
}
