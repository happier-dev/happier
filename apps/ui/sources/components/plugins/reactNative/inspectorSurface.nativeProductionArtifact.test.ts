import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    PluginUiArtifactsManifestV1Schema,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import { encodeBase64 } from '@/encryption/base64';

import {
    createPluginReactNativeBundleCache,
    preloadReactNativeInstalledArtifactBytes,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';
import {
    createRepackInstalledArtifactModuleLoader,
    createRepackScriptManagerBackendFromClient,
    loadPluginReactNativeBundleModule,
} from './loader';

type InstalledArtifactResolver = (scriptId: string, caller?: string) => Promise<unknown>;
type NativeProductionArtifactGraph = PluginUiArtifactsManifestEntryV1 & Readonly<{
    tier: 'reactNative';
    platform: 'ios' | 'android';
    compat: PluginUiArtifactsManifestEntryV1['compat'] & Readonly<{
        reactNative: string;
    }>;
    repack: Readonly<{
        containerName: string;
        modulePath: string;
        exportName: string;
    }>;
}>;

const PRODUCTION_ARTIFACT_ROOT = fileURLToPath(
    new URL(
        '../../../../../../packages/plugins/inspector/dist/happier-plugin-ui/',
        import.meta.url,
    ),
);

function readProductionArtifactGraph(
    platform: 'ios' | 'android',
): NativeProductionArtifactGraph {
    const manifest = PluginUiArtifactsManifestV1Schema.parse(
        JSON.parse(readFileSync(`${PRODUCTION_ARTIFACT_ROOT}ui-artifacts.json`, 'utf8')),
    );
    const graph = manifest.entries.find((entry) =>
        entry.tier === 'reactNative' && entry.platform === platform
    );
    if (
        !graph
        || graph.tier !== 'reactNative'
        || graph.platform !== platform
        || !graph.compat.reactNative
        || !graph.repack
    ) {
        throw new Error(`missing inspector ${platform} Re.Pack production artifact graph`);
    }
    return graph as NativeProductionArtifactGraph;
}

describe('inspector native production artifact graph', () => {
    it.each(['ios', 'android'] as const)(
        'keeps React JSX runtime host-provided in the generated %s graph',
        (platform) => {
            const graph = readProductionArtifactGraph(platform);
            const executableSource = graph.files
                .filter((file) => !file.relativePath.endsWith('.map'))
                .map((file) => readFileSync(
                    `${PRODUCTION_ARTIFACT_ROOT}${file.relativePath}`,
                    'utf8',
                ))
                .join('\n');

            expect(executableSource).toContain('react/jsx-runtime');
            expect(executableSource).not.toContain('react-jsx-runtime.production.js');
            expect(executableSource).not.toContain('reactJsxRuntime_production');
            expect(executableSource).not.toContain('REACT_ELEMENT_TYPE');
        },
    );

    it.each(['ios', 'android'] as const)(
        'verifies and loads the exact generated %s graph with its declared Re.Pack identity',
        async (platform) => {
            const graph = readProductionArtifactGraph(platform);
            const files = graph.files.map((file) => {
                const bytes = new Uint8Array(
                    readFileSync(`${PRODUCTION_ARTIFACT_ROOT}${file.relativePath}`),
                );
                return {
                    ...file,
                    bytes,
                    bytesBase64: encodeBase64(bytes),
                };
            });
            const entryFile = files.find((file) => file.relativePath === graph.entry);
            if (!entryFile) {
                throw new Error(`missing inspector ${platform} graph entry bytes`);
            }
            const identity: PluginReactNativeBundleCacheIdentity = {
                pluginId: 'happier.inspector',
                contributionId: graph.contributionId,
                artifactDigest: graph.digest,
                hostAppVersion: '0.0.0-production-fixture',
                hostUiApiVersion: graph.hostUiApiVersion,
                reactVersion: graph.compat.react,
                reactNativeVersion: graph.compat.reactNative,
                platform,
                channel: 'internal',
                nativeCapabilitiesDigest:
                    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                projectionGeneration: 1,
            };
            const cache = createPluginReactNativeBundleCache();

            await expect(preloadReactNativeInstalledArtifactBytes({
                cache,
                identity,
                artifactGraph: graph,
                fetchArtifactBytes: async () => ({
                    ok: true,
                    cacheIdentity: identity,
                    artifact: {
                        pluginId: identity.pluginId,
                        contributionId: identity.contributionId,
                        artifactKind: 'reactNativeBundle',
                        digest: graph.digest,
                        format: 'plainJs',
                        byteSize: entryFile.byteSize,
                    },
                    bytesBase64: entryFile.bytesBase64,
                    files: files.map((file) => ({
                        relativePath: file.relativePath,
                        digest: file.digest,
                        byteSize: file.byteSize,
                        bytesBase64: file.bytesBase64,
                    })),
                }),
            })).resolves.toEqual({
                ok: true,
                cacheKey: expect.any(String),
            });

            let installedArtifactResolver: InstalledArtifactResolver | null = null;
            const scriptManager = {
                addResolver: vi.fn((resolver: InstalledArtifactResolver) => {
                    installedArtifactResolver = resolver;
                }),
                removeResolver: vi.fn(),
                loadScript: vi.fn(async (scriptId: string) => {
                    expect(await installedArtifactResolver?.(scriptId)).toMatchObject({
                        url: expect.stringContaining(encodeURIComponent(graph.entry)),
                        absolute: true,
                    });
                    expect(await installedArtifactResolver?.(
                        'src_ui_renderSurface_tsx',
                        graph.repack.containerName,
                    )).toMatchObject({
                        url: expect.stringContaining(
                            encodeURIComponent('src_ui_renderSurface_tsx.chunk.bundle'),
                        ),
                        absolute: true,
                    });
                }),
            };
            const renderSurface = () => React.createElement('InspectorNativeProductionFixture');
            const federated = {
                importModule: vi.fn(async () => ({
                    [graph.repack.exportName]: renderSurface,
                })),
            };
            const resolveInstalledArtifactFileUrl = vi.fn(async (input: Readonly<{
                file?: Readonly<{ relativePath: string }>;
            }>) => `file:///production-fixture/${encodeURIComponent(input.file?.relativePath ?? 'missing-entry')}`);
            const backend = createRepackScriptManagerBackendFromClient({
                client: {
                    ScriptManager: { shared: scriptManager },
                    Federated: federated,
                },
                loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                    resolveInstalledArtifactFileUrl,
                }),
            });

            await expect(loadPluginReactNativeBundleModule({
                cache,
                identity,
                backend,
                moduleReference: graph.repack,
                hostPlatform: platform,
            })).resolves.toEqual({
                ok: true,
                module: { renderSurface },
            });
            expect(federated.importModule).toHaveBeenCalledWith(
                graph.repack.containerName,
                graph.repack.modulePath,
            );
            expect(resolveInstalledArtifactFileUrl).toHaveBeenNthCalledWith(1, expect.objectContaining({
                bytes: entryFile.bytes,
                file: expect.objectContaining({
                    relativePath: graph.entry,
                    digest: entryFile.digest,
                }),
            }));
        },
    );
});
