import { describe, expect, it } from 'vitest';

import { extractMcpServersFromClaudeArgs } from './runClaude';

describe('extractMcpServersFromClaudeArgs', () => {
    it('extracts mcpServers and preserves non-mcp config fields', () => {
        const raw = JSON.stringify({
            mcpServers: {
                foo: { type: 'http', url: 'https://example.com' },
            },
            other: { keep: true },
        });

        const result = extractMcpServersFromClaudeArgs(['--mcp-config', raw, '--other-flag']);
        expect(result.mcpServers).toEqual({ foo: { type: 'http', url: 'https://example.com' } });
        expect(result.claudeArgs).toEqual([
            '--mcp-config',
            JSON.stringify({ other: { keep: true } }),
            '--other-flag',
        ]);
    });

    it('removes --mcp-config when it only contains mcpServers', () => {
        const raw = JSON.stringify({ mcpServers: { foo: { type: 'http', url: 'https://example.com' } } });
        const result = extractMcpServersFromClaudeArgs(['--mcp-config', raw, '--x']);
        expect(result.mcpServers).toEqual({ foo: { type: 'http', url: 'https://example.com' } });
        expect(result.claudeArgs).toEqual(['--x']);
    });

    it('keeps raw --mcp-config when JSON is invalid', () => {
        const result = extractMcpServersFromClaudeArgs(['--mcp-config', '{', '--x']);
        expect(result.mcpServers).toEqual({});
        expect(result.claudeArgs).toEqual(['--mcp-config', '{', '--x']);
    });
});
