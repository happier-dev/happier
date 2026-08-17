import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    PluginUiArtifactsManifestV1Schema,
    PluginUiArtifactDigestV1Schema,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginReactNativeBundleCache,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';
import {
    createRepackInstalledArtifactModuleLoader,
    createRepackScriptManagerBackendFromClient,
    loadPluginReactNativeBundleModule,
} from './loader';

type InstalledArtifactResolver = (scriptId: string, caller?: string) => Promise<unknown>;
type NativeProductionArtifactGraph = Omit<
    PluginUiArtifactsManifestEntryV1,
    'tier' | 'platform' | 'compat' | 'repack'
> & Readonly<{
    tier: 'reactNative';
    platform: 'ios' | 'android';
    compat: PluginUiArtifactsManifestEntryV1['compat'] & Readonly<{
        react: string;
        reactNative: string;
    }>;
    repack: NonNullable<PluginUiArtifactsManifestEntryV1['repack']>;
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
        || !graph.compat.react
        || !graph.compat.reactNative
        || !graph.repack
    ) {
        throw new Error(`missing inspector ${platform} Re.Pack production artifact graph`);
    }
    return {
        ...graph,
        tier: graph.tier,
        platform: graph.platform,
        compat: {
            ...graph.compat,
            react: graph.compat.react,
            reactNative: graph.compat.reactNative,
        },
        repack: graph.repack,
    };
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
        'loads the exact generated %s graph with its declared Re.Pack identity',
        async (platform) => {
            const graph = readProductionArtifactGraph(platform);
            const files = graph.files.map((file) => {
                const bytes = new Uint8Array(
                    readFileSync(`${PRODUCTION_ARTIFACT_ROOT}${file.relativePath}`),
                );
                return {
                    ...file,
                    bytes,
                };
            });
            const entryFile = files.find((file) => file.relativePath === graph.entry);
            if (!entryFile) {
                throw new Error(`missing inspector ${platform} graph entry bytes`);
            }
            const renderSurfaceChunk = files.find((file) =>
                file.relativePath.endsWith('.chunk.bundle')
                && file.relativePath.includes('src_ui_renderSurface_tsx-')
            );
            const renderSurfaceChunkFileName = renderSurfaceChunk?.relativePath
                .split(/[\\/]/u)
                .filter(Boolean)
                .pop();
            if (!renderSurfaceChunk || !renderSurfaceChunkFileName) {
                throw new Error(`missing inspector ${platform} render surface chunk`);
            }
            const renderSurfaceChunkScriptId = renderSurfaceChunkFileName.slice(
                0,
                -'.chunk.bundle'.length,
            );
            const artifactDigest = PluginUiArtifactDigestV1Schema.parse(graph.digest);
            const identity: PluginReactNativeBundleCacheIdentity = {
                pluginId: 'happier.inspector',
                contributionId: graph.contributionId,
                artifactDigest,
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

            expect(cache.putInstalledArtifact({
                identity,
                bytes: entryFile.bytes,
                format: 'plainJs',
                entryRelativePath: graph.entry,
                files: files.map((file) => ({
                    relativePath: file.relativePath,
                    digest: file.digest,
                    byteSize: file.byteSize,
                    bytes: file.bytes,
                })),
            })).toEqual({
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
                        renderSurfaceChunkScriptId,
                        graph.repack.containerName,
                    )).toMatchObject({
                        url: expect.stringContaining(
                            encodeURIComponent(renderSurfaceChunk.relativePath),
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
