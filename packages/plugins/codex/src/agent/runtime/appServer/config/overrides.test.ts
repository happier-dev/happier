import { describe, expect, it } from 'vitest';
import { listHappierToolAutoApprovedNamesV1 } from '@happier-dev/protocol/tools/happierToolAutoApprovalV1';

import { buildCodexAppServerConfigOverrides } from './overrides';

function listOverrides(...args: Parameters<typeof buildCodexAppServerConfigOverrides>): readonly string[] {
    const { processOverrides, mcpOverrides } = buildCodexAppServerConfigOverrides(...args);
    return [...processOverrides, ...mcpOverrides];
}

describe('buildCodexAppServerConfigOverrides', () => {
    it.each(['no_tools', 'read_only'] as const)('projects normalized %s Run configuration into native launch restrictions', (permissionMode) => {
        const configuration = permissionMode === 'no_tools'
            ? { allowedTools: [], unlistedTools: 'deny' as const }
            : { allowedTools: ['WebSearch', 'mcp__docs__*'] };
        const overrides = listOverrides({ docs: { command: 'docs-server', enabledTools: ['read'] } }, configuration);
        if (permissionMode === 'no_tools') {
            expect(overrides).toEqual(expect.arrayContaining(['features.shell_tool=false', 'features.view_image=false', 'web_search="disabled"']));
            expect(overrides.some(value => value.startsWith('mcp_servers.'))).toBe(false);
        } else {
            expect(overrides).toContain('mcp_servers.happier__docs.command="docs-server"');
            expect(overrides).not.toContain('features.shell_tool=false');
        }
    });
    it('projects Off and deny through native filters and mediates Allow as prompt', () => {
        const overrides = listOverrides({
            'linear__team': { command: 'bridge', enabledTools: ['read', 'write', 'inspect'] },
            locked: { command: 'bridge' },
            happier: { command: 'bridge' },
        }, {
            mcpToolPolicy: {
                'linear__team': { unlisted: 'ask', tools: { read: 'allow', write: 'off', inspect: 'ask', 'tool.with.dot': 'deny' } },
                locked: { unlisted: 'deny', tools: { approved: 'allow', blocked: 'deny' } },
                happier: { unlisted: 'deny', tools: { change_title: 'off' } },
            },
        });
        expect(overrides).toContain('mcp_servers.happier__linear_team.enabled_tools=["read","inspect"]');
        expect(overrides).toContain('mcp_servers.happier__linear_team.disabled_tools=["write","tool.with.dot"]');
        expect(overrides).toContain('mcp_servers.happier__linear_team.default_tools_approval_mode="prompt"');
        expect(overrides).toContain('mcp_servers.happier__linear_team.tools."read".approval_mode="prompt"');
        expect(overrides).toContain('mcp_servers.happier__locked.enabled_tools=["approved"]');
        expect(overrides).not.toContain('mcp_servers.happier.disabled_tools=["change_title"]');
        expect(overrides).not.toContain('mcp_servers.happier__linear_team.default_tools_approval_mode="approve"');
    });
    it('removes native command, file, connector and delegation tools under an exclusive MCP recipe', () => {
        const overrides = listOverrides({}, {
            unlistedTools: 'deny',
            allowedTools: ['mcp__wilson-intake__*'],
        });

        expect(overrides).toEqual(expect.arrayContaining([
            'features.shell_tool=false',
            'features.view_image=false',
            'features.apps=false',
            'features.multi_agent=false',
            'features.multi_agent_v2=false',
            'features.code_mode.enabled=false',
            'features.code_mode.excluded_tool_namespaces=["functions"]',
            'features.code_mode.direct_only_tool_namespaces=["happier_host"]',
            'web_search="disabled"',
        ]));
    });

    it('keeps explicitly listed native web search available under deny', () => {
        const overrides = listOverrides({}, {
            unlistedTools: 'deny', allowedTools: ['WebSearch'],
        });
        expect(overrides).toContain('web_search="cached"');
    });

    it('retains the host-filtered native MCP tool catalog including an empty catalog', () => {
        const overrides = listOverrides({
            'wilson-intake': { command: 'bridge', enabledTools: ['intake_lead'] },
            happier: { command: 'bridge', enabledTools: [] },
        });
        expect(overrides).toContain('mcp_servers.happier__wilson-intake.enabled_tools=["intake_lead"]');
        expect(overrides).toContain('mcp_servers.happier__wilson-intake.default_tools_approval_mode="approve"');
        expect(overrides).toContain('mcp_servers.happier.enabled_tools=[]');
    });

    it('refuses a confined MCP server without the canonical host tool catalog', () => {
        expect(() => listOverrides({ wilson: { command: 'bridge' } }, {
            unlistedTools: 'deny', allowedTools: ['mcp__wilson__*'],
        })).toThrow(expect.objectContaining({ code: 'codex_tool_restriction_catalog_unavailable' }));
    });

    it('translates materialized Happier MCP servers into additive app-server config overrides', () => {
        const overrides = listOverrides({
            happier: {
                command: '/tmp/happier-mcp-bridge',
                args: ['--url', 'http://127.0.0.1:0'],
                env: {
                    HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: '/tmp/bridge-config.json',
                },
            },
        });

        expect(overrides).toEqual([
            'mcp_servers.happier.command="/tmp/happier-mcp-bridge"',
            'mcp_servers.happier.args=["--url","http://127.0.0.1:0"]',
            'mcp_servers.happier.env={HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE="/tmp/bridge-config.json"}',
            'mcp_servers.happier.enabled=true',
            'mcp_servers.happier.required=true',
            'mcp_servers.happier.startup_timeout_sec=60',
            'mcp_servers.happier.tool_timeout_sec=2147000',
            ...listHappierToolAutoApprovedNamesV1().map((name) => `mcp_servers.happier.tools.${name}.approval_mode="approve"`),
        ]);
    });

    it('requires the first-party Happier bridge within the app-server startup budget', () => {
        const overrides = listOverrides({
            happier: { command: 'happier-mcp' },
        }, {
            processEnv: {
                HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000',
            },
        });

        // Codex awaits a required server fully and fails thread/start when it
        // cannot initialize, so Happier tools are never silently missing.
        expect(overrides).toContain('mcp_servers.happier.required=true');
        expect(overrides).toContain('mcp_servers.happier.startup_timeout_sec=90');
        expect(overrides.some(override => override.startsWith('mcp_optional_startup_grace_ms='))).toBe(false);
    });

    it('leaves injected third-party servers on Codex startup defaults so they cannot hold the first turn', () => {
        const overrides = listOverrides({
            happier: { command: 'happier-mcp' },
            docs: { command: 'docs-mcp' },
        }, {
            processEnv: { HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '90000' },
            mcpToolPolicy: { docs: { unlisted: 'ask', tools: { read: 'ask' } } },
        });
        const thirdParty = overrides.filter(override => override.startsWith('mcp_servers.happier__docs.'));
        expect(thirdParty).toContain('mcp_servers.happier__docs.enabled=true');
        expect(thirdParty.some(override => /\.(required|startup_timeout_sec|startup_timeout_ms)=/.test(override))).toBe(false);
        expect(overrides.some(override => override.startsWith('mcp_optional_startup_grace_ms='))).toBe(false);
    });

    it('prefixes configured server names so user Codex MCP entries cannot collide with Happier-injected ones', () => {
        const overrides = listOverrides({
            context7: {
                command: 'echo',
                args: ['hello'],
            },
            'server.with spaces': {
                command: 'node',
            },
        });

        expect(overrides).toContain('mcp_servers.happier__context7.command="echo"');
        expect(overrides).toContain('mcp_servers.happier__server_with_spaces.command="node"');
        expect(overrides).not.toContain('mcp_servers.context7.command="echo"');
        expect(overrides.some((override) => override.includes('.tool_timeout_sec='))).toBe(false);
        expect(overrides.some((override) => override.includes('.tools.change_title.approval_mode'))).toBe(false);
    });

    it('uses the bounded configured timeout only for the first-party Happier MCP bridge', () => {
        const overrides = listOverrides({
            happier: { command: 'happier-mcp' },
            context7: { command: 'context7-mcp' },
        }, {
            processEnv: {
                HAPPIER_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS: '7230500',
            },
        });

        expect(overrides).toContain('mcp_servers.happier.tool_timeout_sec=7230.5');
        expect(overrides.some((override) => (
            override.startsWith('mcp_servers.happier__context7.')
            && override.includes('tool_timeout_sec')
        ))).toBe(false);
    });

    it('falls back to the safe default and caps oversized configured timeouts', () => {
        const servers = { happier: { command: 'happier-mcp' } };

        expect(listOverrides(servers, {
            processEnv: { HAPPIER_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS: 'not-a-number' },
        })).toContain('mcp_servers.happier.tool_timeout_sec=2147000');
        expect(listOverrides(servers, {
            processEnv: { HAPPIER_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS: '59999' },
        })).toContain('mcp_servers.happier.tool_timeout_sec=2147000');
        expect(listOverrides(servers, {
            processEnv: { HAPPIER_CODEX_HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS: '999999999999' },
        })).toContain('mcp_servers.happier.tool_timeout_sec=2147000');
    });

    it('does not generate ambiguous injected server keys with namespace separators in the sanitized fragment', () => {
        const overrides = listOverrides({
            'foo__bar': {
                command: 'echo',
            },
        });

        expect(overrides).toContain('mcp_servers.happier__foo_bar.command="echo"');
        expect(overrides).not.toContain('mcp_servers.happier__foo__bar.command="echo"');
    });
});
