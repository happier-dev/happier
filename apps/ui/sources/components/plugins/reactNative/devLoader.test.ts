import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    createRepackDevServerModuleLoader,
    loadPluginReactNativeDevServerExport,
    loadPluginReactNativeDevServerModule,
} from './devLoader';
import {
    createDefaultRepackScriptManagerBackend,
    createFailClosedRepackScriptManagerBackend,
    type PluginReactNativeLoaderBackend,
    type RepackScriptManagerRuntimeApi,
} from './loader';

type DevServerResolver = (scriptId: unknown) => Promise<unknown>;
type DevServerResolverOptions = Readonly<{ key: string; priority: number }>;

const DEV_URL = 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true';

function readDevServerResolverOptions(value: unknown): DevServerResolverOptions {
    if (
        !value
        || typeof value !== 'object'
        || typeof (value as { key?: unknown }).key !== 'string'
        || typeof (value as { priority?: unknown }).priority !== 'number'
    ) {
        throw new Error('Expected Re.Pack resolver options');
    }
    return value as DevServerResolverOptions;
}

describe('React Native dev-hot-reload loader', () => {
    it('registers a cache:false dev resolver, loads the script, imports the federated surface, and removes the resolver', async () => {
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        let resolver: DevServerResolver | null = null;
        const scriptManager = {
            addResolver: vi.fn((registered: unknown, _options?: unknown) => {
                resolver = registered as DevServerResolver;
            }),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (scriptId: unknown) => {
                const locator = await resolver?.(scriptId);
                expect(locator).toEqual({ url: DEV_URL, absolute: true, cache: false });
            }),
        } satisfies RepackScriptManagerRuntimeApi['scriptManager'];
        const federated = { importModule: vi.fn(async () => module) };

        const loadDevServerBundle = createRepackDevServerModuleLoader();
        const loaded = await loadDevServerBundle({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            repack: {
                scriptManager,
                federated,
            },
        });

        expect(typeof loaded).toBe('function');
        expect(scriptManager.addResolver).toHaveBeenCalledTimes(1);
        const [, rawOptions] = scriptManager.addResolver.mock.calls[0] ?? [];
        const options = readDevServerResolverOptions(rawOptions);
        expect(options).toEqual({
            key: expect.stringContaining('happier-dev-hot-reload:'),
            priority: 0,
        });
        expect(federated.importModule).toHaveBeenCalledWith('acme_preview_native_preview', './renderSurface');
        expect(scriptManager.removeResolver).toHaveBeenCalledWith(options.key);
    });

    it('loads dev-hot-reload from the declared container, module path, and non-default export', async () => {
        const PluginPanel = () => React.createElement('PluginNativeSurface', { testID: 'plugin-panel' });
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async () => undefined),
        } satisfies RepackScriptManagerRuntimeApi['scriptManager'];
        const federated = { importModule: vi.fn(async () => ({ PluginPanel })) };

        const loaded = await createRepackDevServerModuleLoader({
            resolveFederatedModule: () => ({
                containerName: 'acmeNativePreview',
                modulePath: './PluginPanel',
                exportName: 'PluginPanel',
            }),
        })({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            repack: {
                scriptManager,
                federated,
            },
        });

        expect(loaded).toBe(PluginPanel);
        expect(federated.importModule).toHaveBeenCalledWith('acmeNativePreview', './PluginPanel');
    });

    it('returns a declared dev-server executable export without surface coercion', async () => {
        const activateClientRuntime = vi.fn();
        const backend = {
            backendId: 'repackScriptManager',
            available: true,
            loadDevServerBundle: vi.fn(async () => activateClientRuntime),
        } satisfies PluginReactNativeLoaderBackend;

        await expect(loadPluginReactNativeDevServerExport({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'client-runtime',
            moduleReference: {
                containerName: 'acmeNativePreview',
                modulePath: './clientRuntime',
                exportName: 'activateClientRuntime',
            },
            backend,
        })).resolves.toEqual({ ok: true, exported: activateClientRuntime });
    });

    it('returns typed unavailable when dev-hot-reload declares a missing export', async () => {
        const backend = createDefaultRepackScriptManagerBackend({
            resolveClient: () => ({
                ScriptManager: {
                    shared: {
                        addResolver: vi.fn(),
                        removeResolver: vi.fn(),
                        loadScript: vi.fn(async () => undefined),
                    },
                },
                Federated: {
                    importModule: vi.fn(async () => ({
                        renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'legacy-surface' }),
                        PluginPanel: () => React.createElement('PluginNativeSurface', { testID: 'plugin-panel' }),
                    })),
                },
            }),
            loadDevServerBundle: createRepackDevServerModuleLoader({
                resolveFederatedModule: () => ({
                    containerName: 'acmeNativePreview',
                    modulePath: './PluginPanel',
                    exportName: 'MissingPanel',
                }),
            }),
        });

        await expect(loadPluginReactNativeDevServerModule({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            backend,
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_surface_module',
            diagnostics: ['invalid_surface_module'],
        });
    });

    it('rejects a dev URL that is not an http(s) dev-server URL without registering a resolver', async () => {
        const scriptManager = { addResolver: vi.fn(), removeResolver: vi.fn(), loadScript: vi.fn() };
        const federated = { importModule: vi.fn() };

        await expect(createRepackDevServerModuleLoader()({
            devUrl: 'file:///cache/bundle.js',
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            repack: { scriptManager, federated },
        })).rejects.toThrow('http(s) dev-server URL');
        expect(scriptManager.addResolver).not.toHaveBeenCalled();
    });

    it('removes the dev resolver even when the dev server load fails (no stale resolver across mounts)', async () => {
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async () => {
                throw new Error('Network request failed');
            }),
        };
        const federated = { importModule: vi.fn() };

        await expect(createRepackDevServerModuleLoader()({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            repack: { scriptManager, federated },
        })).rejects.toThrow('Network request failed');
        expect(federated.importModule).not.toHaveBeenCalled();
        expect(scriptManager.removeResolver).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the Re.Pack backend is unavailable', async () => {
        await expect(loadPluginReactNativeDevServerModule({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            backend: createFailClosedRepackScriptManagerBackend('Re.Pack ScriptManager is not installed'),
        })).resolves.toEqual({
            ok: false,
            code: 'loader_backend_unavailable',
            diagnostics: ['repack_script_manager_unavailable'],
        });
    });

    it('maps a dev-server fetch failure to the unreachable host-loader state', async () => {
        const backend = createDefaultRepackScriptManagerBackend({
            resolveClient: () => ({
                ScriptManager: {
                    shared: {
                        addResolver: vi.fn(),
                        removeResolver: vi.fn(),
                        loadScript: vi.fn(async () => {
                            throw new Error('Network request failed for dev server');
                        }),
                    },
                },
                Federated: { importModule: vi.fn() },
            }),
        });

        await expect(loadPluginReactNativeDevServerModule({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            backend,
        })).resolves.toEqual({
            ok: false,
            code: 'dev_server_unreachable',
            diagnostics: ['dev_server_unreachable'],
        });
    });

    it('maps a dev-server syntax failure to the compile host-loader state', async () => {
        const backend = createDefaultRepackScriptManagerBackend({
            resolveClient: () => ({
                ScriptManager: {
                    shared: {
                        addResolver: vi.fn(),
                        removeResolver: vi.fn(),
                        loadScript: vi.fn(async () => {
                            throw new SyntaxError('Unexpected token in bundle');
                        }),
                    },
                },
                Federated: { importModule: vi.fn() },
            }),
        });

        await expect(loadPluginReactNativeDevServerModule({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            backend,
        })).resolves.toEqual({
            ok: false,
            code: 'dev_server_compile_error',
            diagnostics: ['dev_server_compile_error'],
        });
    });

    it('loads a dev-server surface module through the default backend runtime', async () => {
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const backend = createDefaultRepackScriptManagerBackend({
            resolveClient: () => ({
                ScriptManager: {
                    shared: {
                        addResolver: vi.fn(),
                        removeResolver: vi.fn(),
                        loadScript: vi.fn(async () => undefined),
                    },
                },
                Federated: { importModule: vi.fn(async () => module) },
            }),
        });

        await expect(loadPluginReactNativeDevServerModule({
            devUrl: DEV_URL,
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            backend,
        })).resolves.toEqual({ ok: true, module });
    });
});
