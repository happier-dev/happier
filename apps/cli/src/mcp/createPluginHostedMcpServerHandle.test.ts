import { describe, expect, it } from 'vitest';

import type { McpServerSpecV1 } from '@happier-dev/plugin-sdk';

import {
    createPluginHostedMcpServerHandle,
    createPluginHostedMcpServerRegistry,
} from './createPluginHostedMcpServerHandle';

function makeSpec(id: string): McpServerSpecV1 {
    return Object.freeze({
        id,
        name: `name-${id}`,
        transport: { kind: 'hosted' },
    });
}

describe('createPluginHostedMcpServerRegistry', () => {
    it('isolates entries per (plugin, spec) pair and removes them on dispose', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec = makeSpec('s1');

        expect(registry.has('plugin-a', 's1')).toBe(false);
        const handle = createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });
        expect(registry.has('plugin-a', 's1')).toBe(true);
        expect(registry.list('plugin-a').map((s) => s.id)).toEqual(['s1']);

        await handle.dispose();
        expect(registry.has('plugin-a', 's1')).toBe(false);
        expect(registry.list('plugin-a')).toEqual([]);
    });

    it('rejects double-registration of the same spec id within the same plugin', () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec = makeSpec('s1');
        createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });
        expect(() =>
            createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry }),
        ).toThrowError(/already active/);
    });

    it('allows the same spec id under different plugins (per-plugin namespacing)', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const handleA = createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec: makeSpec('shared'), registry });
        const handleB = createPluginHostedMcpServerHandle({ pluginId: 'plugin-b', spec: makeSpec('shared'), registry });
        expect(registry.list('plugin-a').map((s) => s.id)).toEqual(['shared']);
        expect(registry.list('plugin-b').map((s) => s.id)).toEqual(['shared']);
        await handleA.dispose();
        await handleB.dispose();
    });

    it('list() does not leak specs across plugins', () => {
        const registry = createPluginHostedMcpServerRegistry();
        createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec: makeSpec('a-only'), registry });
        createPluginHostedMcpServerHandle({ pluginId: 'plugin-b', spec: makeSpec('b-only'), registry });
        expect(registry.list('plugin-a').map((s) => s.id)).toEqual(['a-only']);
        expect(registry.list('plugin-b').map((s) => s.id)).toEqual(['b-only']);
        expect(registry.list('plugin-c')).toEqual([]);
    });

    it('list() does not match plugins whose ids share a prefix', () => {
        const registry = createPluginHostedMcpServerRegistry();
        createPluginHostedMcpServerHandle({ pluginId: 'plugin', spec: makeSpec('s1'), registry });
        createPluginHostedMcpServerHandle({ pluginId: 'plugin-extended', spec: makeSpec('s2'), registry });
        expect(registry.list('plugin').map((s) => s.id)).toEqual(['s1']);
        expect(registry.list('plugin-extended').map((s) => s.id)).toEqual(['s2']);
    });

    it('handle.dispose is idempotent and re-registration succeeds afterwards', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec = makeSpec('s1');
        const handle = createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });

        await handle.dispose();
        await handle.dispose();
        expect(registry.has('plugin-a', 's1')).toBe(false);

        const reAdded = createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });
        expect(registry.has('plugin-a', 's1')).toBe(true);
        await reAdded.dispose();
    });
});
