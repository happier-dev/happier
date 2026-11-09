import { describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installHomeGovernanceBoundaries(createHomeGovernanceHarness());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import { DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { createBrowserPluginUiPersistentArtifactStore } from '@/sync/domains/plugins/ui/artifactByteCache.browser';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import { createPluginAccountAvailabilityReader, type PluginAccountAvailabilitySnapshot } from './reader';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
const { resolveBundledPluginUiRendererArtifact } = await import('./bundledPluginUiRendererArtifact');
const { readPluginUiDaemonProjectionSelection, readPluginUiGeneratedArtifactGraph,
    readPluginUiReactNativeBundleCacheIdentity } = await import('../ui/artifactAdoption');
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { createBundledPluginUiAppExactArtifactSourceFromInventory } from './bundledAppExactArtifactSource';
const { createPluginReactNativeArtifactAvailabilityProducer } = await import('./reactNativeArtifactAvailability');

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

const accountLifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const inactiveAppExactSource = Object.freeze({ kind: 'appExact' as const, fetch: async () => null });

/**
 * The device's persistent Artifact custody survives a process restart. This
 * fake is the storage boundary only: every reader, integrity check, cache and
 * lease below is the real implementation.
 */
function createDurableCacheStorage(): CacheStorage {
    const stores = new Map<string, Map<string, Response>>();
    const requestUrl = (request: RequestInfo | URL): string => {
        if (typeof request === 'string') return request;
        return request instanceof URL ? request.href : request.url;
    };
    return {
        open: async (name) => {
            const records = stores.get(name) ?? new Map<string, Response>();
            stores.set(name, records);
            return {
                match: async (request: RequestInfo | URL) => records.get(requestUrl(request))?.clone(),
                put: async (request: RequestInfo | URL, response: Response) => {
                    records.set(requestUrl(request), response.clone());
                },
                delete: async (request: RequestInfo | URL) => records.delete(requestUrl(request)),
                keys: async () => [...records.keys()].map((url) => new Request(url)),
            } as unknown as Cache;
        },
        delete: async (name) => stores.delete(name),
        has: async (name) => stores.has(name),
        keys: async () => [...stores.keys()],
        match: async () => undefined,
    };
}

function fixture(input: Readonly<{
    platform?: PluginReactNativeBundleCacheIdentity['platform'];
    entryBytes?: Uint8Array;
}> = {}) {
    const platform = input.platform ?? 'ios';
    const artifactContributionId = 'native-preview';
    const artifactId = 'native-preview-artifact';
    const entryPath = `react-native/${artifactId}/entry.cjs.bundle`;
    const entryBytes = input.entryBytes ?? new TextEncoder().encode('// entry bundle bytes');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
    ] as const;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
    ]);
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId: 'com.acme.preview', version: '1.2.3' },
        archiveDigestSha256,
        normalizedManifest: {
            schemaVersion: 2,
            id: 'com.acme.preview',
            version: '1.2.3',
            displayName: 'Acme preview',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [{
            contributionId: artifactContributionId,
            artifactId,
            tier: 'reactNative',
            platform,
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] },
    });
    const materialization: PluginMachineMaterializationV1 = {
        serverIdentityId: 'srv_account_one',
        machineId: 'machine-a',
        materializationId: 'install-epoch-a',
        pluginId: 'com.acme.preview',
        version: '1.2.3',
        sourceClass: 'versionedArchive',
        portableRelease: true,
        archiveDigestSha256,
        uiArtifacts: [{
            contributionId: artifactContributionId,
            artifactId,
            tier: 'reactNative',
            platform,
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    // Account Availability is read from the SERVER over the closed Availability
    // HTTP family, not from a daemon. A cold process with an unreachable daemon
    // still resolves this projection.
    const snapshot = {
        availabilityCursor: 7,
        intentReads: [{
            pluginId: materialization.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                availabilityCursor: 7,
                packageAssets: [],
                hostingCapability: { enabled: false },
                intent: {
                    pluginId: materialization.pluginId,
                    desiredVersion: materialization.version,
                    enabled: true,
                    offlineUiHosting: 'disabled',
                    writableCollections: [],
                    revision: 'intent-1',
                },
                release,
                uiArtifacts: [],
            }),
        }],
        materializations: [materialization],
        snapshots: [{
            serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId,
            materializations: [materialization],
        }],
    } satisfies PluginAccountAvailabilitySnapshot;
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot });
    const cacheIdentity = {
        pluginId: materialization.pluginId,
        contributionId: artifactContributionId,
        artifactId,
        artifactDigest,
        platform,
    } satisfies PluginReactNativeBundleCacheIdentity;
    const artifactGraph = {
        artifactId,
        tier: 'reactNative' as const,
        entry: entryPath,
        files,
        digest: artifactDigest,
        builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
        executable: { exports: ['renderSurface'] as const },
        hostUiApiRange: '^1.0.0',
    };
    const origin = {
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: {
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        },
    } as const;
    const daemonResponse = DaemonPluginUiArtifactBytesReadResponseSchema.parse({
        ok: true as const,
        artifactFamily: 'reactNative' as const,
       
        cacheIdentity: { artifactDigest },
        artifact: {
            artifactKind: 'reactNativeBundle' as const,
            digest: artifactDigest,
            format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        files: [
            { ...files[0], bytesBase64: encodeBase64(entryBytes) },
        ],
    });
    return { reader, snapshot, cacheIdentity, artifactGraph, origin, daemonResponse };
}

describe('browser Artifact byte reuse across reload and Resume', () => {
    it('reselects current app bytes after reload despite a retained daemon selection and persistent old bytes', async () => {
        const oldBytes = new TextEncoder().encode('// retained renderer');
        const newBytes = new TextEncoder().encode('// current renderer');
        const old = fixture({ platform: 'web', entryBytes: oldBytes });
        const current = fixture({ platform: 'web', entryBytes: newBytes });
        const pluginId = old.cacheIdentity.pluginId;
        const contributionId = old.cacheIdentity.contributionId;
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId,
            version: '1.2.3', displayName: 'Fixture', runtime: { apiVersion: 1 }, contributes: { ui: {
                renderers: [{ id: contributionId, kind: 'reactNative', artifact: old.cacheIdentity.artifactId }],
            } } });
        const entries = (graph: typeof old.artifactGraph) => projectPluginPortableUiDeclarationsV1(manifest, [graph]);
        const entryId = `reactNativeBundle:${pluginId}:${contributionId}`;
        // The renderer selection survives a process, independently of the
        // content-addressed byte record. A materialization ref has no custody.
        const retained = { ...entries(old.artifactGraph)[entryId], artifactSelectionOwner: 'daemonProjection',
            occurrenceId: 'retained-session-selection' };
        const origin = PluginMachineExecutionOriginV1Schema.parse(old.origin);
        const browserStore = createBrowserPluginUiPersistentArtifactStore(createDurableCacheStorage());
        const persistentIdentity = { ...old.cacheIdentity, accountScope: scope };
        await browserStore.write({ persistentIdentity, bytes: oldBytes, entryRelativePath: old.artifactGraph.entry,
            files: [{ ...old.artifactGraph.files[0]!, bytes: oldBytes }] });
        const restore = installBundledPluginUiDeclarationsForTests([{ pluginId, pluginVersion: manifest.version,
            packageName: '@happier-dev/plugins-fixture', displayName: 'Fixture', normalizedManifest: manifest,
            entriesById: entries(current.artifactGraph), artifactGraphs: [current.artifactGraph] }]);
        try {
            const reader = createPluginAccountAvailabilityReader({ scope,
                snapshot: { availabilityCursor: 8, intentReads: [], materializations: [], snapshots: [] },
                hostBundledUi: [{ pluginId, pluginVersion: manifest.version, packageName: '@happier-dev/plugins-fixture',
                    displayName: 'Fixture', normalizedManifest: manifest, entriesById: entries(current.artifactGraph),
                    artifactGraphs: [current.artifactGraph] }],
            });
            const accountProjection = reader.readAccountUiProjection();
            const selected = resolveBundledPluginUiRendererArtifact(retained,
                { accountProjection, selectedProjection: accountProjection });
            const artifactGraph = readPluginUiGeneratedArtifactGraph(selected)!;
            const runtime = selected?.runtime as Readonly<{ cacheIdentity?: unknown }>;
            const cacheIdentity = readPluginUiReactNativeBundleCacheIdentity(runtime.cacheIdentity, {
                pluginId, contributionId, artifactId: artifactGraph.artifactId, platform: 'web',
            })!;
            const cache = createPluginReactNativeBundleCache({ persistentStore:
                adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(browserStore) });
            const producer = createPluginReactNativeArtifactAvailabilityProducer({ getCache: () => cache,
                appExact: createBundledPluginUiAppExactArtifactSourceFromInventory({ inventory: [{ pluginId,
                    releaseVersion: manifest.version, artifactId: current.artifactGraph.artifactId, tier: 'reactNative',
                    digest: current.artifactGraph.digest, files: [{ relativePath: current.artifactGraph.entry, asset: 1 }] }],
                    readBundledAssetBytes: async () => newBytes }),
                fetchDaemonArtifactBytes: async () => { throw new Error('No daemon is needed for app bytes'); },
            });
            const daemonProjectionSelection = readPluginUiDaemonProjectionSelection(selected);
            const result = await producer.acquire({ reader, executionOrigin: origin, artifactGraph, cacheIdentity,
                accountLifetime, isCurrent: () => true,
                ...(daemonProjectionSelection ? { daemonProjectionSelection: { ...daemonProjectionSelection, isCurrent: () => true } } : {}),
            });
            expect(result.kind).toBe('available');
            expect(cache.readInstalledArtifact(current.cacheIdentity, scope)?.bytes).toEqual(newBytes);
            // Selecting the current graph neither aliases nor deletes old bytes.
            expect((await browserStore.read(persistentIdentity))?.bytes).toEqual(oldBytes);
            if (result.kind === 'available') result.dispose();
        } finally { restore(); }
    });

    it('transfers a multi-MiB digest once while retained and reads it again after device custody is emptied', async () => {
        const entryBytes = new TextEncoder().encode(`// ${'x'.repeat(3 * 1024 * 1024)}\n`);
        const current = fixture({ platform: 'web', entryBytes });
        const cacheStorage = createDurableCacheStorage();
        let transferredResponseBytes = 0;
        let artifactReads = 0;
        // This is the external daemon-RPC boundary. The production source,
        // digest verification, persistence and executable cache remain real.
        const fetchDaemonArtifactBytes = async () => {
            artifactReads += 1;
            transferredResponseBytes += new TextEncoder().encode(JSON.stringify(current.daemonResponse)).byteLength;
            return current.daemonResponse;
        };
        const openBrowserProcess = () => {
            const browserStore = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
            const cache = createPluginReactNativeBundleCache({
                persistentStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(browserStore),
            });
            const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
                scope,
                isCurrent: () => true,
                onRetire: () => Object.freeze({ dispose: () => {} }),
            });
            const reader = createPluginAccountAvailabilityReader({ scope, snapshot: current.snapshot });
            const producer = createPluginReactNativeArtifactAvailabilityProducer({
                getCache: () => cache,
                appExact: inactiveAppExactSource,
                fetchDaemonArtifactBytes,
            });
            return {
                browserStore,
                mount: async () => {
                    const result = await producer.acquire({
                        reader,
                        artifactGraph: current.artifactGraph,
                        cacheIdentity: current.cacheIdentity,
                        accountLifetime: lifetime,
                        daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
                        isCurrent: () => true,
                    });
                    expect(result.kind).toBe('available');
                    const installed = cache.readInstalledArtifact(current.cacheIdentity, scope);
                    expect(installed?.bytes.byteLength).toBe(entryBytes.byteLength);
                    expect(installed?.bytes.every((byte, index) => byte === entryBytes[index])).toBe(true);
                    if (result.kind === 'available') result.dispose();
                },
            };
        };

        const warm = openBrowserProcess();
        await warm.mount();
        expect(artifactReads).toBe(1);
        const coldTransferBytes = transferredResponseBytes;
        expect(coldTransferBytes).toBeGreaterThan(3 * 1024 * 1024);
        // Resuming/remounting keeps the same byte custody; a browser reload
        // recreates every process-local reader, lifetime, producer and cache.
        await warm.mount();
        const reloaded = openBrowserProcess();
        await reloaded.mount();
        await reloaded.mount();
        await openBrowserProcess().mount();
        expect(artifactReads).toBe(1);
        expect(transferredResponseBytes - coldTransferBytes).toBe(0);

        // Sensitivity: the same admitted digest with no retained bytes must
        // cross the boundary again. A no-op transport counter cannot pass.
        await reloaded.browserStore.removeAccount(scope);
        await openBrowserProcess().mount();
        expect(artifactReads).toBe(2);
        expect(transferredResponseBytes - coldTransferBytes).toBe(coldTransferBytes);
    });
});

describe('cold process Artifact mount with every daemon unreachable', () => {
    it('mounts Account-qualified bytes from device custody and refuses once that custody is empty', async () => {
        const current = fixture();
        const cacheStorage = createDurableCacheStorage();
        const browserStore = createBrowserPluginUiPersistentArtifactStore(cacheStorage);
        // The browser tier reaches the RN bundle cache through the same
        // canonical adaptation `createDefaultPersistentArtifactStore` uses.
        const persistentStore = adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(browserStore);

        // Warm run: a reachable daemon supplies the bytes once, and the
        // Account-qualified custody keeps them on the device.
        const warmProducer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => createPluginReactNativeBundleCache({ persistentStore }),
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        const warm = await warmProducer.acquire({
            reader: current.reader,
            artifactGraph: current.artifactGraph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            isCurrent: () => true,
        });
        expect(warm.kind).toBe('available');

        // Cold process: a brand new in-memory cache, no explicit daemon route,
        // and an unreachable advertised daemon that fails if reached.
        // The journey is "laptop asleep, phone on cellular": every daemon is
        // unreachable while the server still answers Account Availability.
        const coldDaemonFetch = vi.fn(async () => {
            throw new Error('the advertised daemon is unreachable');
        });
        const coldProducer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => createPluginReactNativeBundleCache({ persistentStore }),
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: coldDaemonFetch,
        });
        const cold = await coldProducer.acquire({
            reader: current.reader,
            artifactGraph: current.artifactGraph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime,
            isCurrent: () => true,
        });
        expect(cold.kind).toBe('available');
        expect(coldDaemonFetch).not.toHaveBeenCalled();

        // Falsification: empty the device custody for this Account. Its
        // advertised byte supplier is attempted but unreachable, so it fails
        // closed instead of mounting anything.
        await browserStore.removeAccount(scope);
        const emptied = await coldProducer.acquire({
            reader: current.reader,
            artifactGraph: current.artifactGraph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime,
            isCurrent: () => true,
        });
        expect(emptied).toMatchObject({ kind: 'unavailable', code: 'artifact_source_unavailable' });
        expect(coldDaemonFetch).toHaveBeenCalledTimes(1);
    });
});
