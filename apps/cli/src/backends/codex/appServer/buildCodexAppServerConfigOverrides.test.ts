import { describe, expect, it } from 'vitest';

import { buildCodexAppServerConfigOverrides } from './buildCodexAppServerConfigOverrides';

describe('buildCodexAppServerConfigOverrides', () => {
    it('translates materialized Happier MCP servers into additive app-server config overrides', () => {
        const overrides = buildCodexAppServerConfigOverrides({
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
        ]);
    });

    it('prefixes configured server names so user Codex MCP entries cannot collide with Happier-injected ones', () => {
        const overrides = buildCodexAppServerConfigOverrides({
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
    });
});
