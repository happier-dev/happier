import { describe, expect, it } from 'vitest';

import {
    createPluginHostedMcpServerHandle,
    createPluginHostedMcpServerRegistry,
} from './createPluginHostedMcpServerHandle';
import type { PluginHostedMcpServerSpec } from './hosted/runtimeTypes';

function makeSpec(id: string): PluginHostedMcpServerSpec {
    return Object.freeze({
        id,
        name: `name-${id}`,
        transport: { kind: 'hosted' as const },
    });
}

describe('createPluginHostedMcpServerRegistry', () => {
    it('isolates entries per (plugin, spec) pair and removes them on dispose', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec = makeSpec('s1');

        expect(registry.has('plugin-a', 's1')).toBe(false);
        const handle = await createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });
        expect(registry.has('plugin-a', 's1')).toBe(true);
        expect(registry.list('plugin-a').map((s) => s.id)).toEqual(['s1']);

        await handle.dispose();
        expect(registry.has('plugin-a', 's1')).toBe(false);
        expect(registry.list('plugin-a')).toEqual([]);
    });

    it('rejects double-registration of the same spec id within the same plugin', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec = makeSpec('s1');
        await createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });
        await expect(
            createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry }),
        ).rejects.toThrowError(/already active/);
    });

    it('rejects invalid registry-only hosted handler specs before storing registry state', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec: PluginHostedMcpServerSpec = {
            ...makeSpec('s1'),
            hosted: {
                tools: [
                    {
                        name: 'unscoped_tool',
                        handler: async () => ({ content: [{ type: 'text', text: 'unexpected' }] }),
                    },
                ],
            },
        };

        await expect(createPluginHostedMcpServerHandle({
            pluginId: 'plugin-a',
            spec,
            registry,
        })).rejects.toThrow(/hosted MCP tool name/i);

        expect(registry.has('plugin-a', 's1')).toBe(false);
    });

    it('rejects secret-bearing registry-only hosted specs before storing registry state', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec = {
            ...makeSpec('s1'),
            hosted: {
                apiToken: 'raw-secret',
                tools: [
                    {
                        name: 'ext.plugin-a.echo',
                        handler: async () => ({ content: [{ type: 'text', text: 'unexpected' }] }),
                    },
                ],
            },
        } as PluginHostedMcpServerSpec;

        await expect(createPluginHostedMcpServerHandle({
            pluginId: 'plugin-a',
            spec,
            registry,
        })).rejects.toThrow(/raw secret material/i);

        expect(registry.has('plugin-a', 's1')).toBe(false);
    });

    it('allows the same spec id under different plugins (per-plugin namespacing)', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const handleA = await createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec: makeSpec('shared'), registry });
        const handleB = await createPluginHostedMcpServerHandle({ pluginId: 'plugin-b', spec: makeSpec('shared'), registry });
        expect(registry.list('plugin-a').map((s) => s.id)).toEqual(['shared']);
        expect(registry.list('plugin-b').map((s) => s.id)).toEqual(['shared']);
        await handleA.dispose();
        await handleB.dispose();
    });

    it('list() does not leak specs across plugins', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        await createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec: makeSpec('a-only'), registry });
        await createPluginHostedMcpServerHandle({ pluginId: 'plugin-b', spec: makeSpec('b-only'), registry });
        expect(registry.list('plugin-a').map((s) => s.id)).toEqual(['a-only']);
        expect(registry.list('plugin-b').map((s) => s.id)).toEqual(['b-only']);
        expect(registry.list('plugin-c')).toEqual([]);
    });

    it('list() does not match plugins whose ids share a prefix', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        await createPluginHostedMcpServerHandle({ pluginId: 'plugin', spec: makeSpec('s1'), registry });
        await createPluginHostedMcpServerHandle({ pluginId: 'plugin-extended', spec: makeSpec('s2'), registry });
        expect(registry.list('plugin').map((s) => s.id)).toEqual(['s1']);
        expect(registry.list('plugin-extended').map((s) => s.id)).toEqual(['s2']);
    });

    it('handle.dispose is idempotent and re-registration succeeds afterwards', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec = makeSpec('s1');
        const handle = await createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });

        await handle.dispose();
        await handle.dispose();
        expect(registry.has('plugin-a', 's1')).toBe(false);

        const reAdded = await createPluginHostedMcpServerHandle({ pluginId: 'plugin-a', spec, registry });
        expect(registry.has('plugin-a', 's1')).toBe(true);
        await reAdded.dispose();
    });

    it('starts explicit hosted endpoint exposure as one registry transaction', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec: PluginHostedMcpServerSpec = {
            ...makeSpec('s1'),
            transport: {
                kind: 'hosted',
                exposure: { kind: 'loopbackHttp', requested: true },
            },
        };
        const endpointDisposeCalls: string[] = [];
        const handle = await createPluginHostedMcpServerHandle({
            pluginId: 'plugin-a',
            spec,
            registry,
            startRuntimeEndpoint: async () => ({
                endpoint: {
                    kind: 'loopbackHttp',
                    url: 'http://127.0.0.1:49152',
                    host: '127.0.0.1',
                    port: 49152,
                },
                dispose: async () => {
                    endpointDisposeCalls.push('disposed');
                },
            }),
        });

        expect(registry.has('plugin-a', 's1')).toBe(true);
        expect('endpoint' in handle ? handle.endpoint : null).toEqual({
            kind: 'loopbackHttp',
            url: 'http://127.0.0.1:49152',
            host: '127.0.0.1',
            port: 49152,
        });

        await handle.dispose();
        await handle.dispose();

        expect(endpointDisposeCalls).toEqual(['disposed']);
        expect(registry.has('plugin-a', 's1')).toBe(false);
    });

    it('removes registry state when explicit hosted endpoint exposure fails to start', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec: PluginHostedMcpServerSpec = {
            ...makeSpec('s1'),
            transport: {
                kind: 'hosted',
                exposure: { kind: 'loopbackHttp', requested: true },
            },
        };

        await expect(Promise.resolve(createPluginHostedMcpServerHandle({
            pluginId: 'plugin-a',
            spec,
            registry,
            startRuntimeEndpoint: async () => {
                throw new Error('endpoint unavailable');
            },
        }))).rejects.toThrow(/endpoint unavailable/);

        expect(registry.has('plugin-a', 's1')).toBe(false);
    });

    it('rejects non-loopback or secret-bearing hosted endpoint descriptors', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec: PluginHostedMcpServerSpec = {
            ...makeSpec('s1'),
            transport: {
                kind: 'hosted',
                exposure: { kind: 'loopbackHttp', requested: true },
            },
        };

        await expect(Promise.resolve(createPluginHostedMcpServerHandle({
            pluginId: 'plugin-a',
            spec,
            registry,
            startRuntimeEndpoint: async () => ({
                endpoint: {
                    kind: 'loopbackHttp',
                    url: 'http://127.0.0.1:49152?token=raw-secret',
                    host: '127.0.0.1',
                    port: 49152,
                },
                dispose: async () => undefined,
            }),
        }))).rejects.toThrow(/sanitized loopback endpoint/);

        expect(registry.has('plugin-a', 's1')).toBe(false);
    });

    it('rejects registry-only endpoint metadata for explicit loopback exposure requests', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec: PluginHostedMcpServerSpec = {
            ...makeSpec('s1'),
            transport: {
                kind: 'hosted',
                exposure: { kind: 'loopbackHttp', requested: true },
            },
        };

        await expect(Promise.resolve(createPluginHostedMcpServerHandle({
            pluginId: 'plugin-a',
            spec,
            registry,
            startRuntimeEndpoint: async () => ({
                endpoint: { kind: 'registryOnly' },
                dispose: async () => undefined,
            }),
        }))).rejects.toThrow(/loopback endpoint/);

        expect(registry.has('plugin-a', 's1')).toBe(false);
    });

    it('rejects hosted endpoint paths because descriptors expose only loopback connection metadata', async () => {
        const registry = createPluginHostedMcpServerRegistry();
        const spec: PluginHostedMcpServerSpec = {
            ...makeSpec('s1'),
            transport: {
                kind: 'hosted',
                exposure: { kind: 'loopbackHttp', requested: true },
            },
        };

        await expect(Promise.resolve(createPluginHostedMcpServerHandle({
            pluginId: 'plugin-a',
            spec,
            registry,
            startRuntimeEndpoint: async () => ({
                endpoint: {
                    kind: 'loopbackHttp',
                    url: 'http://127.0.0.1:49152/raw-secret',
                    host: '127.0.0.1',
                    port: 49152,
                },
                dispose: async () => undefined,
            }),
        }))).rejects.toThrow(/sanitized loopback endpoint/);

        expect(registry.has('plugin-a', 's1')).toBe(false);
    });
});
