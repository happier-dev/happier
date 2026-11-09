import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
    createPluginReactNativeBundleCache,
    derivePluginReactNativeBundleCacheKey,
} from './bundleCache';
import { createPluginReactNativeModuleRegistry } from './moduleRegistry';
import {
    createPluginUiReactNativeRuntimeProjectionReconciler,
} from './projectionInvalidation';
import { getPluginUiClientExecutableComposition } from './clientExecutableContributions';
import { createPluginUiCommonJsLoaderBackend } from './commonJsLoaderBackend';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { settleAppShellPluginRuntimeUpdate } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiReactNativeBundleProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

function identity(projectionGeneration: number) {
    return Object.freeze({
        pluginId: 'acme.preview',
        contributionId: 'client-runtime',
        artifactId: 'client-runtime',
        artifactDigest: projectionGeneration === 12
            ? 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const
            : 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' as const,
        platform: 'web',
    });
}

function bundle(cacheIdentity: ReturnType<typeof identity>): PluginUiReactNativeBundleProjection {
    return Object.freeze({
        id: `reactNativeBundle:${cacheIdentity.pluginId}:${cacheIdentity.contributionId}`,
        pluginId: cacheIdentity.pluginId,
        contributionKind: 'reactNativeBundle' as const,
        contributionId: cacheIdentity.contributionId,
        artifactGraph: Object.freeze({
            artifactId: cacheIdentity.artifactId,
            tier: 'reactNative' as const,
            entry: `react-native/${cacheIdentity.artifactId}/entry.cjs.bundle`,
            files: Object.freeze([Object.freeze({
                relativePath: `react-native/${cacheIdentity.artifactId}/entry.cjs.bundle`,
                digest: cacheIdentity.artifactDigest,
                byteSize: 1,
            })]),
            digest: cacheIdentity.artifactDigest,
            builtWith: Object.freeze({ bundler: 'esbuild' as const, version: '0.27.2' }),
            executable: Object.freeze({ exports: Object.freeze(['renderSurface']) }),
            hostUiApiRange: '^1.0.0',
        }),
        runtime: Object.freeze({
            decision: Object.freeze({ state: 'load', reason: 'compatible', diagnostics: Object.freeze([]) }),
            loadPolicy: Object.freeze({ source: 'installedArtifact' }),
            cacheKey: derivePluginReactNativeBundleCacheKey(cacheIdentity),
            cacheIdentity: Object.freeze({ artifactDigest: cacheIdentity.artifactDigest }),
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
    it('validates a retained source graph only when its bundles change, while rechecking currentness', () => {
        const cache = createPluginReactNativeBundleCache();
        const modules = createPluginReactNativeModuleRegistry();
        const owner = createPluginUiReactNativeRuntimeProjectionReconciler({ cache, surfaceModules: modules });
        const source = owner.createSource();
        const neighbour = owner.createSource();
        let current = true;
        const entry = bundle(identity(12));
        const projection = model(12, [entry]);
        const parse = vi.spyOn(PluginUiArtifactsManifestEntryV2Schema, 'safeParse');
        try {
            source.update({ projection, accountLifetime: null, isCurrent: () => current });
            expect(parse).toHaveBeenCalledTimes(1);
            for (let index = 0; index < 20; index += 1) {
                neighbour.update({ projection: model(index), accountLifetime: null, isCurrent: () => true });
                source.update({ projection, accountLifetime: null, isCurrent: () => current });
            }
            expect(parse).toHaveBeenCalledTimes(1);
            const nextIdentity = identity(13);
            cache.putInstalledArtifact({ identity: nextIdentity, format: 'plainJs', bytes: new Uint8Array([1]) });
            source.update({ projection: model(13, [bundle(nextIdentity)]), accountLifetime: null, isCurrent: () => current });
            expect(parse).toHaveBeenCalledTimes(2);
            expect(cache.readInstalledArtifact(nextIdentity)).not.toBeNull();
            current = false;
            neighbour.update({ projection: model(21), accountLifetime: null, isCurrent: () => true });
            expect(cache.readInstalledArtifact(nextIdentity)).toBeNull();
        } finally { parse.mockRestore(); source.dispose(); neighbour.dispose(); }
    });

    it('retains an exact Account registration while settling the next complete set and replaces changed Account custody', async () => {
        const composition = getPluginUiClientExecutableComposition();
        const cache = createPluginReactNativeBundleCache();
        const cacheIdentity = identity(12);
        const target = { realm: 'account' as const, artifactId: cacheIdentity.artifactId,
            exportName: 'activate', platform: 'web' as const };
        const contributes = PluginContributesV2Schema.parse({ actions: [{
            id: 'read', title: 'Read Account', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: target.artifactId, exportName: target.exportName } },
        }] });
        cache.putInstalledArtifact({ identity: cacheIdentity, format: 'plainJs', bytes: new TextEncoder().encode(
            "exports.activate = function(api) { api.actions.register('read', async function() { return 'Account value'; }); };",
        ) });
        const authority = { kind: 'account' as const, serverId: 'server-1', accountId: 'account-1', custodyId: 'account-release-1' };
        const activation = { pluginId: cacheIdentity.pluginId, contributes, target, executionOrigin: null,
            occurrenceId: authority.custodyId, hostUiApiRange: '^1.0.0', pluginVersion: '1.0.0',
            cache, identity: cacheIdentity, moduleReference: { exportName: target.exportName },
            backend: createPluginUiCommonJsLoaderBackend(), authority, isCurrent: () => true };
        const address = { family: 'actions' as const, pluginId: activation.pluginId, localId: 'read',
            target, executionOrigin: null, occurrenceId: authority.custodyId };
        try {
            expect(await composition.reconcile([activation])).toMatchObject([{ result: { ok: true } }]);
            const registration = composition.read(address);
            expect(registration).not.toBeNull();
            // The Account target has not changed. A foreign Machine/census
            // publication must not withdraw its already committed capability.
            await composition.retain([activation]);
            expect(await settleAppShellPluginRuntimeUpdate({
                isCancelled: () => false,
                activate: async () => {
                    expect(composition.read(address)).toBe(registration);
                    return await composition.reconcile([activation]);
                },
            })).toMatchObject({ status: 'ready' });
            expect(composition.read(address)).toBe(registration);
            expect(registration?.lifecycle.isCurrent()).toBe(true);

            const replacement = { ...activation, authority: { ...authority, accountId: 'account-2', custodyId: 'account-release-2' },
                occurrenceId: 'account-release-2' };
            expect(await composition.reconcile([replacement])).toMatchObject([{ result: { ok: true } }]);
            expect(registration?.lifecycle.signal.aborted).toBe(true);
            expect(composition.read(address)).toBeNull();
            expect(composition.read({ ...address, occurrenceId: replacement.occurrenceId })).not.toBeNull();
        } finally { await composition.unload(); }
    });

    it('does not retain dormant alternate hot-reload or runtime-policy owners', () => {
        expect(existsSync(new URL('./hotReload.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./hotReload.test.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./runtimePolicy.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./runtimePolicy.test.ts', import.meta.url))).toBe(false);
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
