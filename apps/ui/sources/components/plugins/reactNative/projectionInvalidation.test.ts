import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
    createPluginReactNativeBundleCache,
    derivePluginReactNativeBundleCacheKey,
} from './bundleCache';
import { createPluginUiExecutableModuleHost } from './executableModuleHost';
import { createPluginReactNativeModuleRegistry } from './moduleRegistry';
import {
    applyPluginUiReactNativeExecutableAuthorityInvalidation,
    createPluginUiReactNativeRuntimeProjectionReconciler,
} from './projectionInvalidation';
import type { PluginReactNativeLoaderBackend } from './loader';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiReactNativeBundleProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

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

function bundle(cacheIdentity: ReturnType<typeof identity>): PluginUiReactNativeBundleProjection {
    return Object.freeze({
        id: `reactNativeBundle:${cacheIdentity.pluginId}:${cacheIdentity.contributionId}`,
        pluginId: cacheIdentity.pluginId,
        contributionKind: 'reactNativeBundle' as const,
        contributionId: cacheIdentity.contributionId,
        runtime: Object.freeze({
            decision: Object.freeze({ state: 'load', reason: 'compatible', diagnostics: Object.freeze([]) }),
            loadPolicy: Object.freeze({ source: 'installedArtifact' }),
            cacheKey: derivePluginReactNativeBundleCacheKey(cacheIdentity),
            cacheIdentity,
        }),
    });
}

function model(
    generation: number,
    bundles: readonly PluginUiReactNativeBundleProjection[] = [],
): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation,
        reactNativeBundlesById: Object.freeze(Object.fromEntries(bundles.map((entry) => [entry.id, entry]))),
    });
}

function accountLifetime(isCurrent: () => boolean): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
        isCurrent,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

function createRetirableAccountLifetime(): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    retire: () => void;
}> {
    let current = true;
    const retireListeners = new Set<() => void>();
    const lifetime = Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
        isCurrent: () => current,
        onRetire: (listener: () => void) => {
            retireListeners.add(listener);
            return Object.freeze({ dispose: () => retireListeners.delete(listener) });
        },
    });
    return Object.freeze({
        lifetime,
        retire: () => {
            if (!current) return;
            current = false;
            for (const listener of [...retireListeners]) listener();
        },
    });
}

describe('plugin UI React Native runtime projection invalidation owner', () => {
    it('does not retain dormant alternate hot-reload or runtime-policy owners', () => {
        expect(existsSync(new URL('./hotReload.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./hotReload.test.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./runtimePolicy.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./runtimePolicy.test.ts', import.meta.url))).toBe(false);
    });

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

        await applyPluginUiReactNativeExecutableAuthorityInvalidation({
            previous: model(12),
            next: model(13),
            executableHost,
        });

        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(unwind).toHaveBeenCalledTimes(1);
    });

    it('reconciles byte and loaded-module caches across current scoped projection sources', () => {
        const cache = createPluginReactNativeBundleCache();
        const surfaceModules = createPluginReactNativeModuleRegistry();
        const generation12Identity = identity(12);
        const generation13Identity = identity(13);
        const sourceAAccount = createRetirableAccountLifetime();
        const sourceBAccountLifetime = accountLifetime(() => true);
        const reconciler = createPluginUiReactNativeRuntimeProjectionReconciler({
            cache,
            surfaceModules,
        });
        const sourceA = reconciler.createSource();
        const sourceB = reconciler.createSource();

        sourceA.update({
            projection: model(12, [bundle(generation12Identity)]),
            accountLifetime: sourceAAccount.lifetime,
            isCurrent: sourceAAccount.lifetime.isCurrent,
        });
        sourceB.update({
            projection: model(13, [bundle(generation13Identity)]),
            accountLifetime: sourceBAccountLifetime,
            isCurrent: () => true,
        });

        const generation12CacheKey = derivePluginReactNativeBundleCacheKey(generation12Identity);
        const generation13CacheKey = derivePluginReactNativeBundleCacheKey(generation13Identity);
        const generation12WriteFence = surfaceModules.captureWriteFence(generation12CacheKey);
        const generation13WriteFence = surfaceModules.captureWriteFence(generation13CacheKey);
        expect(generation12WriteFence).not.toBeNull();
        expect(generation13WriteFence).not.toBeNull();
        expect(surfaceModules.write(generation12CacheKey, { renderSurface: vi.fn() }, generation12WriteFence!)).toBe(true);
        expect(surfaceModules.write(generation13CacheKey, { renderSurface: vi.fn() }, generation13WriteFence!)).toBe(true);
        cache.putInstalledArtifact({
            identity: generation12Identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });
        cache.putInstalledArtifact({
            identity: generation13Identity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });

        expect(cache.readInstalledArtifact(generation12Identity)).not.toBeNull();
        expect(cache.readInstalledArtifact(generation13Identity)).not.toBeNull();
        expect(surfaceModules.read(generation12CacheKey)).not.toBeNull();
        expect(surfaceModules.read(generation13CacheKey)).not.toBeNull();

        sourceAAccount.retire();

        expect(cache.readInstalledArtifact(generation12Identity)).toBeNull();
        expect(surfaceModules.read(generation12CacheKey)).toBeNull();
        expect(cache.readInstalledArtifact(generation13Identity)).not.toBeNull();
        expect(surfaceModules.read(generation13CacheKey)).not.toBeNull();

        sourceA.dispose();
        sourceB.dispose();
        expect(cache.readInstalledArtifact(generation13Identity)).toBeNull();
        expect(surfaceModules.read(generation13CacheKey)).toBeNull();
    });
});
