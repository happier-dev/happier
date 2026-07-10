import { describe, expect, it } from 'vitest';

import {
    formatCodexMcpToolSource,
    readCodexMcpToolSource,
} from './mcpToolSource.js';

describe('codex MCP tool source projection', () => {
    it('preserves injected Happier MCP server names that contain namespace separators', () => {
        const source = readCodexMcpToolSource(
            {
                type: 'function_call',
                name: 'mcp__happier__context7__resolve-library-id',
            },
            'mcp__happier__context7__resolve-library-id',
        );

        expect(source).toEqual({
            kind: 'mcp',
            serverName: 'happier__context7',
            toolName: 'resolve-library-id',
        });
        expect(source ? formatCodexMcpToolSource(source) : null).toBe(
            'mcp__happier__context7__resolve-library-id',
        );
    });

    it('parses historical injected server names whose sanitized fragment contained namespace separators', () => {
        const source = readCodexMcpToolSource(
            {
                type: 'function_call',
                name: 'mcp__happier__foo__bar__search',
            },
            'mcp__happier__foo__bar__search',
        );

        expect(source).toEqual({
            kind: 'mcp',
            serverName: 'happier__foo__bar',
            toolName: 'search',
        });
        expect(source ? formatCodexMcpToolSource(source) : null).toBe(
            'mcp__happier__foo__bar__search',
        );
    });

    it('normalizes only the injected native Happier server alias', () => {
        const source = readCodexMcpToolSource(
            {
                type: 'function_call',
                server: 'happier__happier',
                tool: 'change_title',
                name: 'change_title',
            },
            'change_title',
        );

        expect(source).toEqual({
            kind: 'mcp',
            serverName: 'happier',
            toolName: 'change_title',
        });
        expect(source ? formatCodexMcpToolSource(source) : null).toBe('mcp__happier__change_title');
    });
});
