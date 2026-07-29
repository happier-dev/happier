import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import { createPluginReactNativeBundleCache } from './bundleCache';
import {
    createFailClosedRepackScriptManagerBackend,
    createRepackScriptManagerBackendFromClient,
    createDefaultRepackScriptManagerBackend,
    createRepackInstalledArtifactModuleLoader,
    loadPluginReactNativeBundleModule,
} from './loader';
import { resolveDefaultNativeRepackClient } from './nativeRepackClientResolver';

type InstalledArtifactResolver = (scriptId: string, caller?: string) => Promise<unknown>;

type InstalledArtifactResolverOptions = Readonly<{
    key: string;
    priority?: number;
}>;

const identity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
} as const;

const requireFromTest = createRequire(import.meta.url);

type ExpoMetroTransform = (
    config: unknown,
    projectRoot: string,
    filename: string,
    data: Buffer,
    options: Readonly<Record<string, unknown>>,
) => Promise<Readonly<{
    dependencies?: readonly unknown[];
    output?: readonly Readonly<{ type?: string }>[];
}>>;

function requireFreshUiMetroConfig(): { transformer: unknown } {
    const metroConfigPath = path.resolve(__dirname, '../../../../metro.config.js');
    delete requireFromTest.cache[metroConfigPath];
    return requireFromTest(metroConfigPath) as { transformer: unknown };
}

async function transformNativeRepackClientResolverWithExpoMetro() {
    const projectRoot = path.resolve(__dirname, '../../../..');
    const filename = path.resolve(__dirname, 'nativeRepackClientResolver.ts');
    const metroWorkerPath = requireFromTest.resolve(
        '@expo/metro-config/build/transform-worker/metro-transform-worker.js',
        { paths: [projectRoot] },
    );
    const { transform } = requireFromTest(metroWorkerPath) as { transform: ExpoMetroTransform };

    return await transform(
        requireFreshUiMetroConfig().transformer,
        projectRoot,
        filename,
        fs.readFileSync(filename),
        {
            customTransformOptions: { environment: 'client' },
            dev: true,
            experimentalImportSupport: false,
            hot: false,
            inlineRequires: false,
            minify: false,
            nonInlinedRequires: [],
            platform: 'web',
            type: 'module',
            unstable_transformProfile: 'hermes-stable',
        },
    );
}

function joinUris(uris: Array<{ uri: string } | string>): string {
    return uris
        .map((uri) => typeof uri === 'string' ? uri : uri.uri)
        .filter(Boolean)
        .reduce((left, right) => {
            if (!left) return right;
            return `${left.replace(/\/+$/u, '')}/${right.replace(/^\/+/u, '')}`;
        }, '');
}

describe('React Native bundle loader adapter', () => {
    it('keeps the default Re.Pack client resolver transformable by Expo Metro for web bundles', async () => {
        const transformed = await transformNativeRepackClientResolverWithExpoMetro();

        expect(transformed.output?.[0]?.type).toBe('js/module');
    });

    it('keeps the default Re.Pack client resolver native-only and inert in test/web runtimes', () => {
        const requireClient = vi.fn(() => ({
            ScriptManager: { shared: {} },
            Federated: {},
        }));

        expect(resolveDefaultNativeRepackClient({
            platformOS: 'ios',
            nodeEnv: 'test',
            requireClient,
        })).toBeNull();
        expect(resolveDefaultNativeRepackClient({
            platformOS: 'web',
            nodeEnv: 'production',
            requireClient,
        })).toBeNull();
        expect(requireClient).not.toHaveBeenCalled();

        const client = { ScriptManager: { shared: {} }, Federated: {} };
        expect(resolveDefaultNativeRepackClient({
            platformOS: 'android',
            nodeEnv: 'production',
            requireClient: vi.fn(() => client),
        })).toBe(client);
    });

    it('exposes the exact default Re.Pack client blocker instead of pretending the backend is loadable', () => {
        expect(createDefaultRepackScriptManagerBackend()).toMatchObject({
            backendId: 'repackScriptManager',
            available: false,
            unavailableReason: '@callstack/repack/client is not installed in this checkout',
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_package_missing',
            ],
        });
    });

    it('can create the default backend from an injected Re.Pack client resolver without a top-level package import', async () => {
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const loadInstalledBundle = vi.fn(async () => module.renderSurface);
        const backend = createDefaultRepackScriptManagerBackend({
            resolveClient: () => ({
                ScriptManager: {
                    shared: {
                        addResolver: vi.fn(),
                        removeResolver: vi.fn(),
                        loadScript: vi.fn(),
                    },
                },
                Federated: {
                    importModule: vi.fn(),
                },
            }),
            loadInstalledBundle,
        });

        expect(backend).toMatchObject({
            backendId: 'repackScriptManager',
            available: true,
            diagnostics: [],
        });
        await expect(backend.loadInstalledBundle?.({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        })).resolves.toBe(module.renderSurface);
        expect(loadInstalledBundle).toHaveBeenCalledWith({
            identity,
            bytes: expect.any(Uint8Array),
            repack: expect.objectContaining({
                scriptManager: expect.any(Object),
                federated: expect.any(Object),
            }),
        });
    });

    it('accepts the real Re.Pack 5 client shape where ScriptManager is a CLASS with a static shared getter', async () => {
        // Re.Pack 5 exports `ScriptManager` as a class: `typeof ScriptManager ===
        // 'function'`, with `shared` as a static getter returning the singleton.
        // The runtime reader must not reject the class container.
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const sharedInstance = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(),
        };
        class FakeScriptManagerClass {
            static get shared() {
                return sharedInstance;
            }
        }
        const loadInstalledBundle = vi.fn(async () => module.renderSurface);
        const backend = createDefaultRepackScriptManagerBackend({
            resolveClient: () => ({
                ScriptManager: FakeScriptManagerClass,
                Federated: {
                    importModule: vi.fn(),
                },
            }),
            loadInstalledBundle,
        });

        expect(backend).toMatchObject({
            backendId: 'repackScriptManager',
            available: true,
            diagnostics: [],
        });
        await expect(backend.loadInstalledBundle?.({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        })).resolves.toBe(module.renderSurface);
    });

    it('does not mark the Re.Pack client runtime loadable until an installed-artifact module adapter is wired', () => {
        const repackClient = {
            ScriptManager: {
                shared: {
                    addResolver: vi.fn(),
                    removeResolver: vi.fn(),
                    loadScript: vi.fn(),
                },
            },
            Federated: {
                importModule: vi.fn(),
            },
        };

        expect(createRepackScriptManagerBackendFromClient({ client: repackClient })).toMatchObject({
            backendId: 'repackScriptManager',
            available: false,
            diagnostics: [
                'repack_script_manager_unavailable',
                'repack_script_manager_installed_artifact_loader_unavailable',
            ],
        });
    });

    it('wires the installed-artifact file materializer when a native Re.Pack client is injected', async () => {
        const installedBytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        const installedIdentity = {
            ...identity,
            artifactDigest: computePluginUiArtifactSha256DigestV1(installedBytes),
        };
        const writes: string[] = [];
        class Directory {
            readonly uri: string;

            constructor(...uris: Array<{ uri: string } | string>) {
                this.uri = joinUris(uris);
            }

            create(): void {}
        }
        class File {
            readonly uri: string;

            constructor(...uris: Array<{ uri: string } | string>) {
                this.uri = joinUris(uris);
            }

            get exists(): boolean {
                return writes.includes(this.uri);
            }

            get size(): number {
                return this.exists ? installedBytes.byteLength : 0;
            }

            async bytes(): Promise<Uint8Array> {
                return installedBytes;
            }

            write(bytes: Uint8Array): void {
                void bytes;
                writes.push(this.uri);
            }
        }
        vi.doMock('expo-file-system', () => ({
            Paths: { cache: new Directory('file:///cache') },
            Directory,
            File,
            writeAsStringAsync: vi.fn(() => {
                throw new Error('legacy file-system API must not be used');
            }),
        }));

        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        let resolver: InstalledArtifactResolver | null = null;
        const scriptManager = {
            addResolver: vi.fn((registeredResolver: InstalledArtifactResolver) => {
                resolver = registeredResolver;
            }),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (scriptId: string) => {
                const locator = await resolver?.(scriptId);
                expect(locator).toMatchObject({
                    url: expect.stringMatching(/^file:\/\//u),
                    absolute: true,
                    cache: false,
                });
                expect(JSON.stringify(locator)).not.toContain('data:');
                expect(JSON.stringify(locator)).not.toContain('https://');
            }),
        };
        const federated = {
            importModule: vi.fn(async () => module),
        };
        const backend = createDefaultRepackScriptManagerBackend({
            resolveClient: () => ({
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            }),
        });

        await expect(backend.loadInstalledBundle?.({
            identity: installedIdentity,
            bytes: installedBytes,
        })).resolves.toBe(module.renderSurface);

        expect(backend.available).toBe(true);
        expect(writes).toHaveLength(1);
        expect(scriptManager.addResolver).toHaveBeenCalledTimes(1);
        expect(scriptManager.removeResolver).toHaveBeenCalledTimes(1);

        vi.doUnmock('expo-file-system');
        vi.resetModules();
    });

    it('fails closed when the pinned Re.Pack ScriptManager backend is unavailable', async () => {
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });

        await expect(loadPluginReactNativeBundleModule({
            cache,
            identity,
            backend: createFailClosedRepackScriptManagerBackend('Re.Pack ScriptManager is not installed'),
        })).resolves.toEqual({
            ok: false,
            code: 'loader_backend_unavailable',
            diagnostics: ['repack_script_manager_unavailable'],
        });
    });

    it('fails closed when installed artifact bytes are missing from the cache', async () => {
        await expect(loadPluginReactNativeBundleModule({
            cache: createPluginReactNativeBundleCache(),
            identity,
            backend: {
                backendId: 'repackScriptManager',
                available: true,
                loadInstalledBundle: vi.fn(),
            },
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_cache_miss',
            diagnostics: ['artifact_cache_miss'],
        });
    });

    it('loads only from installed cache bytes through the adapter backend', async () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const loadInstalledBundle = vi.fn(async () => module.renderSurface);

        await expect(loadPluginReactNativeBundleModule({
            cache,
            identity,
            backend: {
                backendId: 'repackScriptManager',
                available: true,
                loadInstalledBundle,
            },
        })).resolves.toEqual({ ok: true, module });
        expect(loadInstalledBundle).toHaveBeenCalledWith({
            identity,
            bytes,
        });
    });

    it('loads installed artifact bytes through a validated Re.Pack client runtime when the host adapter is available', async () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        let observedScriptManagerThis: unknown = null;
        let observedFederatedThis: unknown = null;
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(function (this: unknown) {
                observedScriptManagerThis = this;
            }),
        };
        const federated = {
            importModule: vi.fn(function (this: unknown) {
                observedFederatedThis = this;
            }),
        };
        const loadInstalledBundle = vi.fn(async ({ repack }) => {
            repack.scriptManager.loadScript('native-preview');
            repack.federated.importModule('acmePreview', './renderSurface');
            return module.renderSurface;
        });

        await expect(loadPluginReactNativeBundleModule({
            cache,
            identity,
            backend: createRepackScriptManagerBackendFromClient({
                client: {
                    ScriptManager: { shared: scriptManager },
                    Federated: federated,
                },
                loadInstalledBundle,
            }),
        })).resolves.toEqual({ ok: true, module });

        expect(loadInstalledBundle).toHaveBeenCalledWith({
            identity,
            bytes,
            repack: {
                scriptManager: expect.objectContaining({
                    addResolver: expect.any(Function),
                    removeResolver: expect.any(Function),
                    loadScript: expect.any(Function),
                }),
                federated: expect.objectContaining({
                    importModule: expect.any(Function),
                }),
            },
        });
        expect(observedScriptManagerThis).toBe(scriptManager);
        expect(observedFederatedThis).toBe(federated);
    });

    it('registers a keyed installed-artifact resolver, loads verified cache bytes, imports the module, and removes the resolver', async () => {
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const scriptManager = {
            addResolver: vi.fn((resolver: InstalledArtifactResolver, options: InstalledArtifactResolverOptions) => {
                void resolver;
                void options;
            }),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (_scriptId: string) => undefined),
        };
        const federated = {
            importModule: vi.fn(async () => module),
        };
        const bytes = new Uint8Array([47, 42, 32, 105, 110, 115, 116, 97, 108, 108, 101, 100, 32, 42, 47]);
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/happier-rn/acme-native-preview.bundle'),
                resolveFederatedModule: () => ({
                    containerName: 'acmeNativePreview',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                }),
            }),
        });

        await expect(backend.loadInstalledBundle?.({ identity, bytes })).resolves.toBe(module.renderSurface);

        expect(scriptManager.addResolver).toHaveBeenCalledTimes(1);
        const registeredResolverCall = scriptManager.addResolver.mock.calls[0];
        if (!registeredResolverCall) {
            throw new Error('expected installed-artifact resolver registration');
        }
        const [installedArtifactResolver, resolverOptions] = registeredResolverCall;
        expect(resolverOptions).toEqual({
            key: expect.stringContaining('happier-installed-artifact:'),
            priority: 0,
        });
        await expect(installedArtifactResolver('unrelated-script')).resolves.toBeUndefined();
        const locator = await installedArtifactResolver(expect.getState().currentTestName ?? '');
        expect(locator).toBeUndefined();
        const loadedScriptId = scriptManager.loadScript.mock.calls[0]?.[0];
        if (!loadedScriptId) {
            throw new Error('expected ScriptManager to load an installed artifact script id');
        }
        const installedLocator = await installedArtifactResolver(loadedScriptId);
        expect(installedLocator).toEqual({
            url: 'file:///cache/happier-rn/acme-native-preview.bundle',
            absolute: true,
            cache: false,
        });
        expect(scriptManager.loadScript).toHaveBeenCalledWith(loadedScriptId);
        expect(federated.importModule).toHaveBeenCalledWith('acmeNativePreview', './renderSurface');
        expect(scriptManager.removeResolver).toHaveBeenCalledWith(resolverOptions.key);
    });

    it('resolves sibling chunk files through the installed-artifact resolver using the Re.Pack chunk id and caller', async () => {
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        let registeredResolver: InstalledArtifactResolver | null = null;
        const scriptManager = {
            addResolver: vi.fn((resolver: InstalledArtifactResolver) => {
                registeredResolver = resolver;
            }),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (scriptId: string) => {
                const entryLocator = await registeredResolver?.(scriptId);
                expect(entryLocator).toMatchObject({ url: 'file:///cache/entry.bundle', absolute: true });
                const chunkLocator = await registeredResolver?.(
                    'src_ui_renderSurface_tsx',
                    'happier_inspector_inspector_app_native',
                );
                expect(chunkLocator).toMatchObject({ url: 'file:///cache/src_ui_renderSurface_tsx.chunk.bundle', absolute: true });
            }),
        };
        const federated = {
            importModule: vi.fn(async () => module),
        };
        const resolveInstalledArtifactFileUrl = vi.fn(async (input: Readonly<{
            file?: Readonly<{ relativePath: string }>;
        }>) => input.file?.relativePath.endsWith('src_ui_renderSurface_tsx.chunk.bundle')
            ? 'file:///cache/src_ui_renderSurface_tsx.chunk.bundle'
            : 'file:///cache/entry.bundle');
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl,
            }),
        });
        const entryBytes = new Uint8Array([47, 47, 32, 101, 110, 116, 114, 121]);
        const chunkBytes = new Uint8Array([47, 47, 32, 99, 104, 117, 110, 107]);
        const legacyIdentity = {
            ...identity,
            artifactDigest: computePluginUiArtifactSha256DigestV1(entryBytes),
        };

        await expect(backend.loadInstalledBundle?.({
            identity: legacyIdentity,
            bytes: entryBytes,
            files: [{
                relativePath: 'react-native/inspector-app-native/ios.bundle.js',
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            }, {
                relativePath: 'react-native/inspector-app-native/src_ui_renderSurface_tsx.chunk.bundle',
                digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                byteSize: chunkBytes.byteLength,
                bytes: chunkBytes,
            }],
        })).resolves.toBe(module.renderSurface);
        expect(resolveInstalledArtifactFileUrl).toHaveBeenCalledWith(expect.objectContaining({
            file: expect.objectContaining({
                relativePath: 'react-native/inspector-app-native/src_ui_renderSurface_tsx.chunk.bundle',
            }),
        }));
    });

    it('loads a generated native graph from its declared entry path without treating the entry as a sibling chunk', async () => {
        const cache = createPluginReactNativeBundleCache();
        const entryRelativePath = 'react-native/native-preview/ios.bundle.js';
        const entryBytes = new TextEncoder().encode('// generated native entry');
        const chunkBytes = new TextEncoder().encode('// generated native chunk');
        cache.putInstalledArtifact({
            identity,
            bytes: entryBytes,
            entryRelativePath,
            format: 'plainJs',
            files: [{
                relativePath: entryRelativePath,
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            }, {
                relativePath: 'react-native/native-preview/src_ui_renderSurface_tsx.chunk.bundle',
                digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                byteSize: chunkBytes.byteLength,
                bytes: chunkBytes,
            }],
        });

        let registeredResolver: InstalledArtifactResolver | null = null;
        const scriptManager = {
            addResolver: vi.fn((resolver: InstalledArtifactResolver) => {
                registeredResolver = resolver;
            }),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (scriptId: string) => {
                expect(await registeredResolver?.(scriptId)).toMatchObject({
                    url: 'file:///cache/ios.bundle.js',
                    absolute: true,
                });
                expect(await registeredResolver?.('ios.bundle.js')).toBeUndefined();
                expect(await registeredResolver?.(
                    'src_ui_renderSurface_tsx',
                    'happier_native_preview',
                )).toMatchObject({
                    url: 'file:///cache/src_ui_renderSurface_tsx.chunk.bundle',
                    absolute: true,
                });
            }),
        };
        const renderSurface = () => React.createElement('PluginNativeSurface');
        const resolveInstalledArtifactFileUrl = vi.fn(async (input: Readonly<{
            file?: Readonly<{ relativePath: string }>;
        }>) => input.file?.relativePath.endsWith('.chunk.bundle')
            ? 'file:///cache/src_ui_renderSurface_tsx.chunk.bundle'
            : 'file:///cache/ios.bundle.js');
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: {
                    importModule: vi.fn(async () => ({ renderSurface })),
                },
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl,
            }),
        });

        await expect(loadPluginReactNativeBundleModule({
            cache,
            identity,
            backend,
        })).resolves.toEqual({
            ok: true,
            module: { renderSurface },
        });
        expect(resolveInstalledArtifactFileUrl).toHaveBeenNthCalledWith(1, expect.objectContaining({
            bytes: entryBytes,
            file: expect.objectContaining({
                relativePath: entryRelativePath,
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            }),
        }));
    });

    it('loads an installed artifact from the declared container, module path, and non-default export', async () => {
        const PluginPanel = () => React.createElement('PluginNativeSurface', { testID: 'plugin-panel' });
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (_scriptId: string) => undefined),
        };
        const federated = {
            importModule: vi.fn(async () => ({ PluginPanel })),
        };
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/happier-rn/acme-native-preview.bundle'),
                resolveFederatedModule: () => ({
                    containerName: 'acmeNativePreview',
                    modulePath: './PluginPanel',
                    exportName: 'PluginPanel',
                }),
            }),
        });

        const loaded = await backend.loadInstalledBundle?.({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        });

        expect(loaded).toBe(PluginPanel);
        expect(federated.importModule).toHaveBeenCalledWith('acmeNativePreview', './PluginPanel');
    });

    it('rejects a verified artifact when the selected loader backend targets another host platform', async () => {
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });

        await expect(loadPluginReactNativeBundleModule({
            cache,
            identity,
            backend: {
                backendId: 'reactNativeWebModule',
                available: true,
                loadInstalledBundle: vi.fn(async () => (
                    () => React.createElement('PluginNativeSurface')
                )),
            },
        })).resolves.toEqual({
            ok: false,
            code: 'platform_mismatch',
            diagnostics: ['artifact_platform_loader_mismatch'],
        });
    });

    it('loads generated web bytes from the declared graph entry path', async () => {
        const cache = createPluginReactNativeBundleCache();
        const webIdentity = { ...identity, platform: 'web' };
        const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
        const chunkBytes = new TextEncoder().encode('export const chunk = true;');
        const entryRelativePath = 'react-native/native-preview/index.js';
        cache.putInstalledArtifact({
            identity: webIdentity,
            // Deliberately make the convenience bytes differ. The loader must use
            // the graph-owned entry path when that metadata is present.
            bytes: chunkBytes,
            entryRelativePath,
            format: 'plainJs',
            files: [{
                relativePath: 'react-native/native-preview/chunk.js',
                digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
                byteSize: chunkBytes.byteLength,
                bytes: chunkBytes,
            }, {
                relativePath: entryRelativePath,
                digest: computePluginUiArtifactSha256DigestV1(entryBytes),
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            }],
        });
        const renderSurface = () => React.createElement('PluginNativeSurface');
        const loadInstalledBundle = vi.fn(async () => renderSurface);

        await expect(loadPluginReactNativeBundleModule({
            cache,
            identity: webIdentity,
            backend: {
                backendId: 'reactNativeWebModule',
                available: true,
                loadInstalledBundle,
            },
        })).resolves.toEqual({
            ok: true,
            module: { renderSurface },
        });
        expect(loadInstalledBundle).toHaveBeenCalledWith({
            identity: webIdentity,
            bytes: entryBytes,
            files: expect.any(Array),
            entryRelativePath,
        });
    });

    it('returns typed unavailable when an installed artifact declares a missing export', async () => {
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (_scriptId: string) => undefined),
        };
        const federated = {
            importModule: vi.fn(async () => ({
                renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'legacy-surface' }),
                PluginPanel: () => React.createElement('PluginNativeSurface', { testID: 'plugin-panel' }),
            })),
        };
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/happier-rn/acme-native-preview.bundle'),
                resolveFederatedModule: () => ({
                    containerName: 'acmeNativePreview',
                    modulePath: './PluginPanel',
                    exportName: 'MissingPanel',
                }),
            }),
        });

        await expect(loadPluginReactNativeBundleModule({ cache, identity, backend })).resolves.toEqual({
            ok: false,
            code: 'invalid_surface_module',
            diagnostics: ['invalid_surface_module'],
        });
    });

    it('rejects installed-artifact resolver URLs that are not native file URLs', async () => {
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(),
        };
        const federated = {
            importModule: vi.fn(),
        };
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'data:application/javascript;base64,dm9pZCAw'),
            }),
        });

        await expect(backend.loadInstalledBundle?.({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        })).rejects.toThrow('must resolve to a file:// URL');

        expect(scriptManager.addResolver).not.toHaveBeenCalled();
        expect(scriptManager.loadScript).not.toHaveBeenCalled();
        expect(federated.importModule).not.toHaveBeenCalled();
    });

    it('removes the installed-artifact resolver when ScriptManager loading fails', async () => {
        const scriptManager = {
            addResolver: vi.fn((_resolver: InstalledArtifactResolver, options: InstalledArtifactResolverOptions) => {
                void options;
            }),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (_scriptId: string) => {
                throw new Error('native load failed');
            }),
        };
        const federated = {
            importModule: vi.fn(),
        };
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/happier-rn/native-preview.bundle'),
            }),
        });

        await expect(backend.loadInstalledBundle?.({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        })).rejects.toThrow('native load failed');

        const registeredResolverCall = scriptManager.addResolver.mock.calls[0];
        if (!registeredResolverCall) {
            throw new Error('expected installed-artifact resolver registration');
        }
        const [, resolverOptions] = registeredResolverCall;
        expect(federated.importModule).not.toHaveBeenCalled();
        expect(scriptManager.removeResolver).toHaveBeenCalledWith(resolverOptions.key);
    });

    // RN-HARDEN: Re.Pack's own `ScriptManager.loadScript` caches the load
    // promise in `scriptsPromises[uniqueId]` (uniqueId === scriptId when we
    // call `loadScript(scriptId)` with no caller arg, as this loader does) and
    // only deletes that cache entry in the `finally` of the load-execution
    // phase — NOT when `resolveScript` (the resolution phase, run via our
    // one-shot resolver) itself throws. A resolver rejection therefore leaves
    // a permanently rejected promise cached forever: every later render's
    // `loadScript(sameScriptId)` replays the SAME cached rejection and our
    // freshly re-registered resolver is never consulted again. Verified
    // directly against `node_modules/@callstack/repack/dist/modules/
    // ScriptManager/ScriptManager.js` (`loadScript`'s `resolveScript` await
    // sits OUTSIDE the try/finally that deletes `scriptsPromises[uniqueId]`).
    // The fix is host-side: on a failed load, force-evict the stale promise
    // via ScriptManager's own `invalidateScripts([scriptId])` API (which
    // deletes `scriptsPromises[scriptId]` directly) before rethrowing, so the
    // NEXT `loadScript` call for the same scriptId always starts fresh.
    it('evicts the ScriptManager rejected-promise cache entry after a failed load so a retry is not replayed', async () => {
        let loadAttempts = 0;
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            invalidateScripts: vi.fn(async (_scriptIds: readonly string[]) => undefined),
            loadScript: vi.fn(async (_scriptId: string) => {
                loadAttempts += 1;
                if (loadAttempts === 1) {
                    throw new Error('native load failed');
                }
            }),
        };
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const federated = {
            importModule: vi.fn(async () => module),
        };
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/happier-rn/native-preview.bundle'),
            }),
        });
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        await expect(backend.loadInstalledBundle?.({ identity, bytes })).rejects.toThrow('native load failed');

        const failedScriptId = scriptManager.loadScript.mock.calls[0]?.[0];
        if (!failedScriptId) {
            throw new Error('expected ScriptManager to attempt loading a script id');
        }
        expect(scriptManager.invalidateScripts).toHaveBeenCalledWith([failedScriptId]);

        // Retry: same identity, same scriptId. Must not be blocked by any
        // host-side memoization of the first failure.
        await expect(backend.loadInstalledBundle?.({ identity, bytes })).resolves.toBe(module.renderSurface);
        expect(scriptManager.loadScript).toHaveBeenCalledTimes(2);
        expect(scriptManager.loadScript.mock.calls[1]?.[0]).toBe(failedScriptId);
        // A successful load must not evict anything.
        expect(scriptManager.invalidateScripts).toHaveBeenCalledTimes(1);
    });

    it('does not fail the original error when ScriptManager has no invalidateScripts API to evict with', async () => {
        const scriptManager = {
            addResolver: vi.fn(),
            removeResolver: vi.fn(),
            loadScript: vi.fn(async (_scriptId: string) => {
                throw new Error('native load failed');
            }),
        };
        const federated = { importModule: vi.fn() };
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: { shared: scriptManager },
                Federated: federated,
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/happier-rn/native-preview.bundle'),
            }),
        });

        await expect(backend.loadInstalledBundle?.({
            identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        })).rejects.toThrow('native load failed');
    });
});
