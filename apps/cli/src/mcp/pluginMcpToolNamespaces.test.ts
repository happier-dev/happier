import { describe, expect, it } from 'vitest';

import {
    assertPluginMcpToolName,
    claimPluginMcpToolNamespace,
    createPluginMcpToolNamespaceRegistry,
    readPluginMcpToolNamespace,
} from './pluginMcpToolNamespaces';

describe('plugin MCP tool namespaces', () => {
    it('accepts canonical MCP tool prefixes', () => {
        expect(readPluginMcpToolNamespace('happier.session.list', 'acme')).toBe('happier');
        expect(readPluginMcpToolNamespace('ext.acme.search', 'acme')).toBe('ext.acme');
        expect(readPluginMcpToolNamespace('codex.github.search', 'acme')).toBe('codex.github');
    });

    it('rejects unprefixed or mismatched extension tool names', () => {
        expect(() => assertPluginMcpToolName('search', 'acme')).toThrow(/canonical MCP tool prefix/);
        expect(() => assertPluginMcpToolName('ext.other.search', 'acme')).toThrow(/plugin namespace/);
    });

    it('rejects same-namespace collisions', () => {
        const registry = createPluginMcpToolNamespaceRegistry();

        claimPluginMcpToolNamespace(registry, {
            pluginId: 'acme',
            toolName: 'ext.acme.search',
            registrationId: 'tool.search',
        });

        expect(() => claimPluginMcpToolNamespace(registry, {
            pluginId: 'acme',
            toolName: 'ext.acme.create',
            registrationId: 'tool.create',
        })).toThrow(/MCP tool namespace collision/);
    });
});
