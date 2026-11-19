import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
    createPluginReactNativeBundleCache,
    derivePluginReactNativeBundleCacheKey,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';
import { createPluginReactNativeModuleRegistry } from './moduleRegistry';
import {
    createPluginUiReactNativeRuntimeProjectionReconciler,
} from './projectionInvalidation';
import { getPluginUiClientExecutableComposition } from './clientExecutableContributions';
import { createPluginUiCommonJsLoaderBackend } from './commonJsLoaderBackend';
import { loadPluginReactNativeBundleExport, loadPluginReactNativeBundleModule } from './loader';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { settleAppShellPluginRuntimeUpdate } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiReactNativeBundleProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

function identity(projectionGeneration: number): PluginReactNativeBundleCacheIdentity {
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
    it('serializes retention keys only for new artifact identities in the changed source', () => {
        const cache = createPluginReactNativeBundleCache();
        const surfaceModules = createPluginReactNativeModuleRegistry();
        const owner = createPluginUiReactNativeRuntimeProjectionReconciler({ cache, surfaceModules });
        const { lifetime, retire } = createRetirableAccountLifetime();
        const identities = Array.from({ length: 4 }, (_, sourceIndex) =>
            Array.from({ length: 24 }, (_, artifactIndex): ReturnType<typeof identity> => {
                const position = sourceIndex * 24 + artifactIndex;
                return { ...identity(12), pluginId: `acme.fixture-${position}`,
                    artifactDigest: `sha256:${position.toString(16).padStart(64, '0')}` };
            }));
        const entries = identities.map((group) => group.map(bundle));
        const sources = entries.map(() => owner.createSource());
        const publish = (sourceIndex: number, projection: PluginUiProjectionModel) => {
            sources[sourceIndex].update({ projection, accountLifetime: lifetime, isCurrent: lifetime.isCurrent });
        };
        entries.forEach((group, index) => publish(index, model(1, group)));
        const retainedIdentity = identities[1][0];
        const replacedIdentity = identities[0][0];
        cache.putInstalledArtifact({ identity: retainedIdentity, format: 'plainJs', bytes: new Uint8Array([1]) });
        cache.putInstalledArtifact({ identity: replacedIdentity, format: 'plainJs', bytes: new Uint8Array([1]) });
        const replacement = { ...identity(13), pluginId: replacedIdentity.pluginId };

        // Observe the actual serialized Account/plugin/contribution keys, with the real caches below the owner.
        const stringify = vi.spyOn(JSON, 'stringify');
        const countKeys = () => {
            const count = stringify.mock.calls.filter(([value]) => Array.isArray(value)
                && value.length === 4 && value[0] === lifetime.scope.serverId && value[1] === lifetime.scope.accountId).length;
            stringify.mockClear();
            return count;
        };
        try {
            publish(0, model(2, entries[0]));
            const unchanged = countKeys();
            publish(0, model(3, [bundle(replacement), ...entries[0].slice(1)]));
            const changed = countKeys();
            const replacementKey = derivePluginReactNativeBundleCacheKey(replacement);
            expect(surfaceModules.captureWriteFence(replacementKey)).not.toBeNull();
            expect(cache.readInstalledArtifact(replacedIdentity)).toBeNull();
            expect(cache.readInstalledArtifact(retainedIdentity)).not.toBeNull();

            sources[1].dispose();
            const disposed = countKeys();
            expect(surfaceModules.captureWriteFence(derivePluginReactNativeBundleCacheKey(retainedIdentity))).toBeNull();
            expect(cache.readInstalledArtifact(retainedIdentity)).not.toBeNull();
            expect({ unchanged, changed, disposed }).toEqual({ unchanged: 0, changed: 1, disposed: 0 });
        } finally {
            stringify.mockRestore();
            sources.forEach((source) => source.dispose());
            retire();
        }
    });

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
        // The Artifact, not the scope that mounted it, owns its bytes; evaluated modules leave with the scope.
        expect(cache.readInstalledArtifact(generation13Identity)).not.toBeNull();
        expect(surfaceModules.read(generation13CacheKey)).toBeNull();
        reconciler.retainEnabledPlugins(sourceBAccountLifetime, new Set());
        expect(cache.readInstalledArtifact(generation13Identity)).toBeNull();
        expect(surfaceModules.read(generation13CacheKey)).toBeNull();
    });

    it('keeps a shared module active until the last source leaves and retains the remaining declaration', () => {
        const cache = createPluginReactNativeBundleCache();
        const surfaceModules = createPluginReactNativeModuleRegistry();
        const owner = createPluginUiReactNativeRuntimeProjectionReconciler({ cache, surfaceModules });
        const { lifetime, retire } = createRetirableAccountLifetime();
        const first = owner.createSource();
        const second = owner.createSource();
        const shared = owner.createSource();
        const older = identity(12);
        const newer = identity(13);
        const olderKey = derivePluginReactNativeBundleCacheKey(older);
        const newerKey = derivePluginReactNativeBundleCacheKey(newer);
        const olderProjection = model(12, [bundle(older)]);
        const publish = (source: typeof first, projection: PluginUiProjectionModel) =>
            source.update({ projection, accountLifetime: lifetime, isCurrent: lifetime.isCurrent });

        publish(shared, olderProjection);
        publish(first, olderProjection);
        publish(second, model(13, [bundle(newer)]));
        for (const installed of [older, newer]) {
            cache.putInstalledArtifact({ identity: installed, format: 'plainJs', bytes: new Uint8Array([1]) });
        }
        const fence = surfaceModules.captureWriteFence(olderKey)!;
        expect(surfaceModules.write(olderKey, { renderSurface: vi.fn() }, fence)).toBe(true);

        shared.dispose();
        owner.releaseRetained();
        expect(surfaceModules.read(olderKey)).not.toBeNull();
        expect(cache.readInstalledArtifact(newer)).not.toBeNull();

        second.dispose();
        expect(surfaceModules.captureWriteFence(newerKey)).toBeNull();
        expect(cache.readInstalledArtifact(newer)).toBeNull();
        expect(surfaceModules.write(olderKey, { renderSurface: vi.fn() }, fence)).toBe(true);

        first.dispose();
        expect(surfaceModules.read(olderKey)).toBeNull();
        expect(cache.readInstalledArtifact(older)).not.toBeNull();
        retire();
        expect(cache.readInstalledArtifact(older)).toBeNull();
    });

    it('compiles a plugin Artifact once across Session opens and leaves, and again only when its Artifact changes', async () => {
        const cache = createPluginReactNativeBundleCache();
        const surfaceModules = createPluginReactNativeModuleRegistry();
        const reconciler = createPluginUiReactNativeRuntimeProjectionReconciler({ cache, surfaceModules });
        const account = createRetirableAccountLifetime();
        const backend = createPluginUiCommonJsLoaderBackend();
        const bytes = new TextEncoder().encode(
            'exports.renderSurface = function () { return null; }; exports.activate = function () { return exports; };',
        );
        const decode = vi.spyOn(TextDecoder.prototype, 'decode');
        let acquisitions = 0;
        let surfaceEvaluations = 0;
        const activationNamespaces = new Set<unknown>();
        // One Session open: its scoped source publishes, its surface mounts (shared module) and
        // its client executable activates (fresh namespace); leaving disposes the source.
        const openAndLeaveSession = async (cacheIdentity: ReturnType<typeof identity>) => {
            const source = reconciler.createSource();
            source.update({ projection: model(1, [bundle(cacheIdentity)]), accountLifetime: account.lifetime,
                isCurrent: account.lifetime.isCurrent });
            if (!cache.readInstalledArtifact(cacheIdentity)) {
                acquisitions += 1;
                cache.putInstalledArtifact({ identity: cacheIdentity, bytes, format: 'plainJs' });
            }
            const cacheKey = derivePluginReactNativeBundleCacheKey(cacheIdentity);
            if (!surfaceModules.read(cacheKey)) {
                const fence = surfaceModules.captureWriteFence(cacheKey);
                const loaded = await loadPluginReactNativeBundleModule({ cache, identity: cacheIdentity, backend });
                surfaceEvaluations += 1;
                expect(loaded.ok && fence && surfaceModules.write(cacheKey, loaded.module, fence)).toBe(true);
            }
            const activation = await loadPluginReactNativeBundleExport({ cache, identity: cacheIdentity,
                moduleReference: { exportName: 'activate' }, backend });
            if (activation.ok) activationNamespaces.add(Reflect.apply(activation.exported, undefined, []));
            source.dispose();
        };
        try {
            for (let open = 0; open < 5; open += 1) await openAndLeaveSession(identity(12));
            expect({ acquisitions, compiles: decode.mock.calls.length, surfaceEvaluations,
                activationNamespaces: activationNamespaces.size })
                .toEqual({ acquisitions: 1, compiles: 1, surfaceEvaluations: 5, activationNamespaces: 5 });

            await openAndLeaveSession(identity(13));
            expect({ acquisitions, compiles: decode.mock.calls.length, surfaceEvaluations })
                .toEqual({ acquisitions: 2, compiles: 2, surfaceEvaluations: 6 });
            // The replaced Artifact is released; the current one stays until the census or Account drops it.
            expect(cache.readInstalledArtifact(identity(12))).toBeNull();
            expect(surfaceModules.read(derivePluginReactNativeBundleCacheKey(identity(12)))).toBeNull();
            expect(cache.readInstalledArtifact(identity(13))).not.toBeNull();

            reconciler.retainEnabledPlugins(account.lifetime, new Set(['acme.preview']));
            expect(cache.readInstalledArtifact(identity(13))).not.toBeNull();
            // Memory pressure releases what no mounted scope declares; the next open re-creates it.
            reconciler.releaseRetained();
            expect(cache.readInstalledArtifact(identity(13))).toBeNull();
            await openAndLeaveSession(identity(13));
            expect({ acquisitions, compiles: decode.mock.calls.length }).toEqual({ acquisitions: 3, compiles: 3 });
            account.retire();
            expect(cache.readInstalledArtifact(identity(13))).toBeNull();
            expect(surfaceModules.read(derivePluginReactNativeBundleCacheKey(identity(13)))).toBeNull();
        } finally { decode.mockRestore(); }
    });
});
