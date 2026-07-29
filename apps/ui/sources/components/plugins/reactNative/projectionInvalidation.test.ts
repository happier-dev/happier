import { describe, expect, it, vi } from 'vitest';

import { createPluginReactNativeBundleCache } from './bundleCache';
import { createPluginUiExecutableModuleHost } from './executableModuleHost';
import { createPluginReactNativeModuleRegistry } from './moduleRegistry';
import { applyPluginUiReactNativeRuntimeProjectionInvalidation } from './projectionInvalidation';
import type { PluginReactNativeLoaderBackend } from './loader';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiArtifactProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

const moduleReference = Object.freeze({
    containerName: 'acme_preview_client_runtime',
    modulePath: './clientRuntime',
    exportName: 'activateClientRuntime',
});

function identity(projectionGeneration: number) {
    return Object.freeze({
        pluginId: 'acme.preview',
        contributionId: 'client-runtime',
        artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        platform: 'web',
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        projectionGeneration,
    });
}

function artifact(): PluginUiArtifactProjection {
    return Object.freeze({
        id: 'uiArtifact:acme.preview:client-runtime',
        pluginId: 'acme.preview',
        contributionKind: 'uiArtifact',
        artifactId: 'client-runtime',
        integrity: { digest: identity(12).artifactDigest },
    });
}

function model(generation: number, artifacts: readonly PluginUiArtifactProjection[]): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation,
        uiArtifactsById: Object.freeze(Object.fromEntries(artifacts.map((entry) => [entry.id, entry]))),
    });
}

describe('plugin UI React Native runtime projection invalidation owner', () => {
    it('retires active executable authority when the projection generation changes', async () => {
        const cache = createPluginReactNativeBundleCache();
        const cleanup = vi.fn();
        const unwind = vi.fn();
        const executableHost = createPluginUiExecutableModuleHost();
        const generation12Identity = identity(12);
        const authority = Object.freeze({
            serverId: 'server-1', machineId: 'machine-1', projectionGeneration: 12,
        });
        cache.putInstalledArtifact({
            identity: generation12Identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });
        await executableHost.replaceAuthority(authority);
        await expect(executableHost.activate({
            cache,
            identity: generation12Identity,
            moduleReference,
            backend: Object.freeze({
                backendId: 'reactNativeWebModule',
                available: true,
                loadInstalledBundle: vi.fn(async () => async () => cleanup),
            }) satisfies PluginReactNativeLoaderBackend,
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind }),
        })).resolves.toEqual({ ok: true });

        await applyPluginUiReactNativeRuntimeProjectionInvalidation({
            previous: model(12, [artifact()]),
            next: model(13, [artifact()]),
            targets: { cache, executableHost },
        });

        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(unwind).toHaveBeenCalledTimes(1);
    });

    it('evicts byte and loaded-module caches while the AppShell target also revokes changed plugins', async () => {
        const cache = createPluginReactNativeBundleCache();
        const surfaceModules = createPluginReactNativeModuleRegistry();
        const generation12Identity = identity(12);
        surfaceModules.write('generation-12-module', { renderSurface: vi.fn() });
        cache.putInstalledArtifact({
            identity: generation12Identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });
        await applyPluginUiReactNativeRuntimeProjectionInvalidation({
            previous: model(12, [artifact()]),
            next: model(13, [artifact()]),
            targets: { cache, surfaceModules },
        });
        expect(cache.readInstalledArtifact(generation12Identity)).toBeNull();
        expect(surfaceModules.read('generation-12-module')).toBeNull();

        const generation13Identity = identity(13);
        surfaceModules.write('generation-13-module', { renderSurface: vi.fn() });
        const cleanupGeneration13 = vi.fn();
        const unwindGeneration13 = vi.fn();
        const executableHost = createPluginUiExecutableModuleHost();
        const authority = Object.freeze({
            serverId: 'server-1', machineId: 'machine-1', projectionGeneration: 13,
        });
        cache.putInstalledArtifact({
            identity: generation13Identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });
        await executableHost.replaceAuthority(authority);
        await expect(executableHost.activate({
            cache,
            identity: generation13Identity,
            moduleReference,
            backend: Object.freeze({
                backendId: 'reactNativeWebModule',
                available: true,
                loadInstalledBundle: vi.fn(async () => async () => cleanupGeneration13),
            }) satisfies PluginReactNativeLoaderBackend,
            hostPlatform: 'web',
            authority,
            createScope: () => ({ api: Object.freeze({}), commit: vi.fn(), unwind: unwindGeneration13 }),
        })).resolves.toEqual({ ok: true });
        await applyPluginUiReactNativeRuntimeProjectionInvalidation({
            previous: model(13, [artifact()]),
            next: model(13, []),
            targets: { cache, executableHost, surfaceModules },
        });
        expect(cache.readInstalledArtifact(generation13Identity)).toBeNull();
        expect(surfaceModules.read('generation-13-module')).toBeNull();
        expect(cleanupGeneration13).toHaveBeenCalledTimes(1);
        expect(unwindGeneration13).toHaveBeenCalledTimes(1);
    });
});
