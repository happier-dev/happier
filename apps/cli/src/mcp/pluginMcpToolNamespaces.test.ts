import { describe, expect, it } from 'vitest';

import {
    assertPluginMcpToolNamespace,
    claimPluginMcpToolNamespacePrefix,
    assertPluginMcpToolName,
    claimPluginMcpToolNamespace,
    createPluginMcpToolNamespaceRegistry,
    readPluginMcpToolNamespace,
    readPluginMcpToolNamespacePrefix,
} from './pluginMcpToolNamespaces';

describe('plugin MCP tool namespaces', () => {
    it('accepts canonical MCP tool prefixes', () => {
        expect(readPluginMcpToolNamespace('happier.session.list', 'acme')).toBe('happier.session');
        expect(readPluginMcpToolNamespace('ext.acme.search', 'acme')).toBe('ext.acme');
        expect(readPluginMcpToolNamespace('codex.github.search', 'acme')).toBe('codex.github');
    });

    it('accepts canonical MCP backend-client tool namespace prefixes', () => {
        expect(readPluginMcpToolNamespacePrefix('happier.session', 'acme')).toBe('happier.session');
        expect(readPluginMcpToolNamespacePrefix('ext.acme', 'acme')).toBe('ext.acme');
        expect(readPluginMcpToolNamespacePrefix('codex.github', 'acme')).toBe('codex.github');
    });

    it('rejects unprefixed or mismatched extension tool names', () => {
        expect(() => assertPluginMcpToolName('search', 'acme')).toThrow(/canonical MCP tool prefix/);
        expect(() => assertPluginMcpToolName('happier.session', 'acme')).toThrow(/canonical MCP tool prefix/);
        expect(() => assertPluginMcpToolName('ext.other.search', 'acme')).toThrow(/plugin namespace/);
        expect(() => assertPluginMcpToolNamespace('search', 'acme')).toThrow(/canonical MCP tool namespace/);
        expect(() => assertPluginMcpToolNamespace('ext.other', 'acme')).toThrow(/plugin namespace/);
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

    it('rejects backend-client namespace collisions with tool namespaces', () => {
        const registry = createPluginMcpToolNamespaceRegistry();

        claimPluginMcpToolNamespacePrefix(registry, {
            pluginId: 'alpha',
            namespace: 'codex.github',
            registrationId: 'client.github',
        });

        expect(() => claimPluginMcpToolNamespace(registry, {
            pluginId: 'beta',
            toolName: 'codex.github.search',
            registrationId: 'tool.search',
        })).toThrow(/MCP tool namespace collision/);
    });
});
