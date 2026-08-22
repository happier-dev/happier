import { describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { logger } from '@/ui/logger';
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
        async listResources() { return { items: [] }; },
        async listResourceTemplates() { return { items: [] }; },
        async readResource() { return { contents: [] }; },
        async subscribeResource() { return { dispose() {} }; },
        async listPrompts() { return { items: [] }; },
        async getPrompt() { return { messages: [] }; },
        dispose,
    };
}

describe('contribution module activation', () => {
    it('passes the canonical speech declaration to unified Voice registration validation', async () => {
        const runtime = Object.freeze({
            kind: 'speech' as const,
            async transcribe(request: Readonly<{ requestId: string }>) {
                return { requestId: request.requestId, text: '' };
            },
        });
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                voiceProviders: [{
                    id: 'speech', title: 'Speech', kind: 'speech',
                    roles: ['dictation_stt'], platforms: ['web'],
                    settings: {
                        schemaVersion: 2,
                        fields: [{
                            id: 'model', title: 'Model',
                            schema: { type: 'string', minLength: 1, maxLength: 256 },
                            default: 'synthetic-stt-v1',
                            presentation: { control: 'text' },
                        }],
                    },
                }],
            }),
            moduleNamespace: {
                activate(api: PluginApi) { api.voiceProviders.register('speech', runtime); },
            },
        });

        expect(result.status).toBe('active');
        expect(result.registrations).toEqual([expect.objectContaining({
            family: 'voiceProviders',
            localId: 'speech',
            value: {
                kind: 'speech',
                transcribe: expect.any(Function),
            },
        })]);
    });

    it('activates the named export once and atomically commits exact derived rights', async () => {
        const activate = vi.fn((api) => {
            api.actions.register('run', async () => ({ ok: true }));
        });
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
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
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
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

    it('commits exactly one public runtime for a managed Provider declaration', async () => {
        const runtime = Object.freeze({
            async start() {
                throw new Error('not invoked during activation');
            },
        });
        const activate = vi.fn((api: PluginApi) => {
            api.providers.register('gateway', runtime);
        });
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                providers: [{
                    v: 1, id: 'gateway', name: 'Gateway', kind: 'aggregator',
                    endpointTemplates: [{
                        id: 'api', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
                        capabilities: {
                            streaming: 'supported', toolRoundTrips: 'supported',
                            statefulResponses: 'unknown', reasoningControls: 'supported',
                        },
                    }],
                    catalog: {
                        source: 'static', manualModelPolicy: 'allowed',
                        staticModels: [{ id: 'example', name: 'Example' }],
                    },
                    managedRuntime: { kind: 'managed', endpointTemplateIds: ['api'] },
                }],
            }),
            moduleNamespace: { activate },
        });

        expect(result.status).toBe('active');
        expect(result.registrations).toEqual([{
            family: 'providers',
            localId: 'gateway',
            value: { managedRuntime: { start: expect.any(Function) } },
        }]);
        expect(activate).toHaveBeenCalledTimes(1);
    });

    it('keeps a descriptor-only Provider dormant and grants no runtime registration', async () => {
        const activate = vi.fn();
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                providers: [{
                    v: 1, id: 'gateway', name: 'Gateway', kind: 'aggregator',
                    endpointTemplates: [{
                        id: 'api', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
                        capabilities: {
                            streaming: 'supported', toolRoundTrips: 'supported',
                            statefulResponses: 'unknown', reasoningControls: 'supported',
                        },
                    }],
                    catalog: {
                        source: 'static', manualModelPolicy: 'allowed',
                        staticModels: [{ id: 'example', name: 'Example' }],
                    },
                }],
            }),
            moduleNamespace: { activate },
        });

        expect(result.status).toBe('dormant');
        expect(result.registrations).toEqual([]);
        expect(activate).not.toHaveBeenCalled();
    });

    it('publishes no managed Provider runtime when activation omits its exact registration', async () => {
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                providers: [{
                    v: 1, id: 'gateway', name: 'Gateway', kind: 'aggregator',
                    endpointTemplates: [{
                        id: 'api', protocol: 'openai-responses', baseUrl: 'https://example.test/v1',
                        capabilities: {
                            streaming: 'supported', toolRoundTrips: 'supported',
                            statefulResponses: 'unknown', reasoningControls: 'supported',
                        },
                    }],
                    catalog: {
                        source: 'static', manualModelPolicy: 'allowed',
                        staticModels: [{ id: 'example', name: 'Example' }],
                    },
                    managedRuntime: { kind: 'managed', endpointTemplateIds: ['api'] },
                }],
            }),
            moduleNamespace: { activate() {} },
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_activation_failed',
                message: expect.stringMatching(/missing registration 'providers\/gateway'/i),
            }),
        ]);
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
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            }),
            moduleNamespace: {
                activate(api: PluginApi) {
                    api.actions.register('run', async () => ({ ok: true }));
                    void cleanup;
                    throw new Error('activation client_secret=activation-secret failed before cleanup return');
                },
            },
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.diagnostics[0]?.message).not.toContain('activation-secret');
        expect(cleanup).not.toHaveBeenCalled();
    });

    it('disposes a registered dynamic MCP runtime once when activation throws before returning', async () => {
        const disposeRuntime = vi.fn(async () => undefined);
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                mcp: { servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }], discoverySources: [] },
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
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
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
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                mcp: { servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }], discoverySources: [] },
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
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
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
                    discoverySources: [],
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
            throw new Error('cleanup client_secret=cleanup-secret failed');
        });

        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            }),
            moduleNamespace: { activate: () => cleanup },
        });

        expect(result.status).toBe('unavailable');
        expect(result.registrations).toEqual([]);
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics[0]?.code).toBe('plugin_activation_failed');
        expect(result.diagnostics[1]?.code).toBe('plugin_activation_failed');
        expect(result.diagnostics[1]?.message).toMatch(/cleanup.*failed/i);
        expect(result.diagnostics[1]?.message).not.toContain('cleanup-secret');
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('bounds and diagnoses resolved cleanup that hangs after graph validation fails', async () => {
        vi.useFakeTimers();
        const cleanup = vi.fn(() => new Promise<void>(() => undefined));
        try {
            const activation = activateContributionModule({
                pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
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

    it('closes a timed-out activation scope and invokes late cleanup exactly once', async () => {
        vi.useFakeTimers();
        let resolveActivation: ((cleanup: () => Promise<void>) => void) | undefined;
        let capturedApi: PluginApi | undefined;
        const cleanup = vi.fn(async () => undefined);
        try {
            const activation = activateContributionModule({
                pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                }),
                moduleNamespace: {
                    activate(api: PluginApi) {
                        capturedApi = api;
                        return new Promise((resolve) => {
                            resolveActivation = resolve;
                        });
                    },
                },
            });
            let settled: Awaited<typeof activation> | null = null;
            void activation.then((result) => {
                settled = result;
            });

            await vi.advanceTimersByTimeAsync(30_000);

            expect(settled).toEqual(expect.objectContaining({
                status: 'unavailable',
                registrations: [],
            }));
            expect(capturedApi).toBeDefined();
            expect(() => capturedApi?.actions.register('run', async () => ({ ok: true })))
                .toThrow(/disposed|retired|current/i);

            resolveActivation?.(cleanup);
            await vi.runAllTimersAsync();

            expect(cleanup).toHaveBeenCalledTimes(1);
        } finally {
            resolveActivation?.(cleanup);
            await vi.runAllTimersAsync();
            vi.useRealTimers();
        }
    });

    it('reports a late cleanup failure after the activation deadline has settled', async () => {
        vi.useFakeTimers();
        let resolveActivation: ((cleanup: () => Promise<void>) => void) | undefined;
        const cleanup = vi.fn(async () => {
            throw new Error('late activation cleanup failed');
        });
        const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        try {
            const activation = activateContributionModule({
                pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                }),
                moduleNamespace: {
                    activate() {
                        return new Promise((resolve) => {
                            resolveActivation = resolve;
                        });
                    },
                },
            });

            await vi.advanceTimersByTimeAsync(30_000);
            await expect(activation).resolves.toEqual(expect.objectContaining({
                status: 'unavailable',
                registrations: [],
            }));

            resolveActivation?.(cleanup);
            await vi.runAllTimersAsync();

            expect(cleanup).toHaveBeenCalledTimes(1);
            expect(warning).toHaveBeenCalledWith(
                '[PLUGIN RUNTIME] Late activation cleanup failed',
                expect.objectContaining({
                    pluginId: 'acme.activation',
                    error: expect.stringMatching(/late activation cleanup failed/i),
                }),
            );
        } finally {
            resolveActivation?.(cleanup);
            await vi.runAllTimersAsync();
            warning.mockRestore();
            vi.useRealTimers();
        }
    });

    it('observes a late activation rejection after the timeout result is final', async () => {
        vi.useFakeTimers();
        let rejectActivation: ((error: Error) => void) | undefined;
        try {
            const activation = activateContributionModule({
                pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                }),
                moduleNamespace: {
                    activate() {
                        return new Promise((_resolve, reject) => {
                            rejectActivation = reject;
                        });
                    },
                },
            });

            await vi.advanceTimersByTimeAsync(30_000);
            await expect(activation).resolves.toEqual(expect.objectContaining({
                status: 'unavailable',
                registrations: [],
                diagnostics: [expect.objectContaining({
                    message: expect.stringMatching(/synchronous.*cannot be preempted/i),
                })],
            }));

            rejectActivation?.(new Error('late activation rejection'));
            await vi.runAllTimersAsync();
        } finally {
            rejectActivation?.(new Error('late activation rejection'));
            await vi.runAllTimersAsync();
            vi.useRealTimers();
        }
    });

    it('allows an unrelated plugin to activate while a peer is waiting for its deadline', async () => {
        vi.useFakeTimers();
        try {
            const hangingActivation = activateContributionModule({
                pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                }),
                moduleNamespace: { activate: () => new Promise(() => undefined) },
            });
            const unrelatedActivation = activateContributionModule({
                pluginId: 'acme.activation', generation: '8', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                }),
                moduleNamespace: {
                    activate(api: PluginApi) {
                        api.actions.register('run', async () => ({ ok: true }));
                    },
                },
            });

            await expect(unrelatedActivation).resolves.toEqual(expect.objectContaining({
                status: 'active',
                registrations: [expect.objectContaining({ family: 'actions', localId: 'run' })],
            }));

            await vi.advanceTimersByTimeAsync(30_000);
            await expect(hangingActivation).resolves.toEqual(expect.objectContaining({
                status: 'unavailable',
                registrations: [],
            }));
        } finally {
            await vi.runAllTimersAsync();
            vi.useRealTimers();
        }
    });

    it('documents that the asynchronous deadline cannot preempt synchronous activation work', async () => {
        vi.useFakeTimers();
        try {
            const activate = vi.fn((api: PluginApi) => {
                api.actions.register('run', async () => ({ ok: true }));
            });

            const activation = activateContributionModule({
                pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
                manifest: manifest({
                    actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
                }),
                moduleNamespace: { activate },
            });

            expect(activate).toHaveBeenCalledTimes(1);
            await expect(activation).resolves.toEqual(expect.objectContaining({ status: 'active' }));
            await vi.advanceTimersByTimeAsync(30_000);
        } finally {
            vi.useRealTimers();
        }
    });
    it('carries a local development source location for an activate export that throws', async () => {
        const sourceRoot = '/Users/alice/workspaces/acme-plugin';
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            localDevelopmentSourceRoot: sourceRoot,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            }),
            moduleNamespace: {
                activate() {
                    const error = new Error("Cannot find module 'left-pad'");
                    error.stack = [
                        "Error: Cannot find module 'left-pad'",
                        `    at activate (${sourceRoot}/src/daemon.ts:12:3)`,
                    ].join('\n');
                    throw error;
                },
            },
        });

        expect(result.status).toBe('unavailable');
        expect(result.diagnostics).toEqual([expect.objectContaining({
            code: 'plugin_activation_failed',
            source: { file: 'src/daemon.ts', line: 12, column: 3 },
        })]);
        expect(result.diagnostics[0]?.message).toContain('src/daemon.ts:12:3');
    });

    it('publishes no source location for an activate export that throws outside the local development realm', async () => {
        const result = await activateContributionModule({
            pluginId: 'acme.activation', generation: '7', isGenerationCurrent: () => true,
            manifest: manifest({
                actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
            }),
            moduleNamespace: {
                activate() {
                    const error = new Error("Cannot find module 'left-pad'");
                    error.stack = [
                        "Error: Cannot find module 'left-pad'",
                        '    at activate (/opt/happier/plugins/acme/dist/daemon.js:12:3)',
                    ].join('\n');
                    throw error;
                },
            },
        });

        expect(result.status).toBe('unavailable');
        expect(result.diagnostics[0]?.source).toBeUndefined();
        expect(result.diagnostics[0]?.stack).toBeUndefined();
    });
});
