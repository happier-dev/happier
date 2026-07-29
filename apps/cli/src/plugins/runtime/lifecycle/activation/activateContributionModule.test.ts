import { describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { activateContributionModule } from './activateContributionModule';

type PluginMcpServerRuntime = Parameters<PluginApi['mcp']['registerServer']>[1];

function manifest(contributes: Record<string, unknown>) {
    const result = ingestCanonicalPluginManifest({
        schemaVersion: 2, id: 'acme.activation', version: '1.0.0', displayName: 'Activation',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' }, contributes,
    });
    if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join('\n'));
    return result.manifest;
}

function mcpRuntime(dispose: PluginMcpServerRuntime['dispose']): PluginMcpServerRuntime {
    return {
        async listTools() { return { items: [] }; },
        async callTool() { return { content: [] }; },
        dispose,
    };
}

describe('contribution module activation', () => {
    it('activates the named export once and atomically commits exact derived rights', async () => {
        const activate = vi.fn((api) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
            }),
            moduleNamespace: { activate },
        });

        expect(result.status).toBe('active');
        expect(result.registrations.map(({ family, localId }) => ({ family, localId }))).toEqual([
            { family: 'actions', localId: 'run' },
        ]);
        expect(activate).toHaveBeenCalledTimes(1);
    });

    it('returns a coded unavailable result when required rights have no daemon activation', async () => {
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
            }),
            moduleNamespace: {},
        });

        expect(result).toEqual(expect.objectContaining({
            status: 'unavailable', registrations: [],
            diagnostics: [expect.objectContaining({ code: 'plugin_activation_failed' })],
        }));
    });

    it('keeps a descriptor-only module dormant without invoking default exports', async () => {
        const defaultExport = vi.fn();
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                resources: [{ id: 'guide', kind: 'asset', path: 'guide.md', contentType: 'text/markdown' }],
            }),
            moduleNamespace: { default: defaultExport },
        });

        expect(result.status).toBe('dormant');
        expect(defaultExport).not.toHaveBeenCalled();
    });

    it('rejects legacy returned-disposable activation without publishing', async () => {
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({}),
            moduleNamespace: { activate: () => ({ dispose() {} }) },
            forceActivation: true,
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
    });

    it('does not invent plugin cleanup when activation throws before returning', async () => {
        const cleanup = vi.fn();
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
            }),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.actions.register('run', async () => ({ ok: true }));
                    void cleanup;
                    throw new Error('activation failed before cleanup return');
                },
            },
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(cleanup).not.toHaveBeenCalled();
    });

    it('disposes a registered dynamic MCP runtime once when activation throws before returning', async () => {
        const disposeRuntime = vi.fn(async () => undefined);
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                mcp: { servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }], discoveryProviders: [] },
            }),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.mcp.registerServer('tools', mcpRuntime(disposeRuntime));
                    throw new Error('activation failed after MCP registration');
                },
            },
        });

        expect(result.status).toBe('unavailable');
        expect(disposeRuntime).toHaveBeenCalledTimes(1);
        await result.dispose();
        expect(disposeRuntime).toHaveBeenCalledTimes(1);
    });

    it('invokes resolved cleanup once when graph validation fails after activation', async () => {
        const cleanup = vi.fn(async () => undefined);
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
            }),
            moduleNamespace: { activate: () => cleanup },
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(cleanup).toHaveBeenCalledTimes(1);
        await result.dispose();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('disposes a registered dynamic MCP runtime before activation cleanup when graph validation fails', async () => {
        const cleanupOrder: string[] = [];
        const disposeRuntime = vi.fn(async () => { cleanupOrder.push('mcp'); });
        const cleanup = vi.fn(async () => { cleanupOrder.push('activation'); });
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
                mcp: { servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }], discoveryProviders: [] },
            }),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.mcp.registerServer('tools', mcpRuntime(disposeRuntime));
                    return cleanup;
                },
            },
        });

        expect(result.status).toBe('unavailable');
        expect(cleanupOrder).toEqual(['mcp', 'activation']);
        expect(disposeRuntime).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
        await result.dispose();
        expect(disposeRuntime).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('invokes resolved cleanup at most once when a successful generation retires', async () => {
        const cleanup = vi.fn(async () => undefined);
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
            }),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.actions.register('run', async () => ({ ok: true }));
                    return cleanup;
                },
            },
        });

        expect(result.status).toBe('active');
        const first = result.dispose();
        const second = result.dispose();
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('disposes registered dynamic MCP runtimes once in reverse order before activation cleanup on retirement', async () => {
        const cleanupOrder: string[] = [];
        const disposeFirst = vi.fn(async () => { cleanupOrder.push('first'); });
        const disposeSecond = vi.fn(async () => { cleanupOrder.push('second'); });
        const cleanup = vi.fn(async () => { cleanupOrder.push('activation'); });
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                mcp: {
                    servers: [
                        { id: 'first', title: 'First', kind: 'dynamic' },
                        { id: 'second', title: 'Second', kind: 'dynamic' },
                    ],
                    discoveryProviders: [],
                },
            }),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.mcp.registerServer('first', mcpRuntime(disposeFirst));
                    api.mcp.registerServer('second', mcpRuntime(disposeSecond));
                    return cleanup;
                },
            },
        });

        expect(result.status).toBe('active');
        const first = result.dispose();
        const second = result.dispose();
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(cleanupOrder).toEqual(['second', 'first', 'activation']);
        expect(disposeFirst).toHaveBeenCalledTimes(1);
        expect(disposeSecond).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('reports a resolved cleanup rejection after graph validation fails', async () => {
        const cleanup = vi.fn(async () => {
            throw new Error('cleanup failed');
        });

        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
            }),
            moduleNamespace: { activate: () => cleanup },
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics[0]?.code).toBe('plugin_activation_failed');
        expect(result.diagnostics[1]?.code).toBe('plugin_activation_failed');
        expect(result.diagnostics[1]?.message).toMatch(/cleanup.*failed/i);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('bounds and diagnoses resolved cleanup that hangs after graph validation fails', async () => {
        vi.useFakeTimers();
        const cleanup = vi.fn(() => new Promise<void>(() => undefined));
        try {
            const activation = activateContributionModule({
                pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placement: 'primary', dangerLevel: 'safe' }],
                }),
                moduleNamespace: { activate: () => cleanup },
                cleanupTimeoutMs: 25,
            });
            await vi.advanceTimersByTimeAsync(25);
            const result = await activation;

            expect(result.status).toBe('unavailable');
            expect(result.diagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ message: expect.stringMatching(/cleanup.*timed out/i) }),
            ]));
            expect(cleanup).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
