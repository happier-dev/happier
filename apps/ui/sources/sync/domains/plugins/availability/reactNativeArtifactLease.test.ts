import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderHook, flushHookEffects } from '@/dev/testkit';

const activeAccountHostedArtifactSource = vi.hoisted(() => ({
    create: vi.fn(),
}));
const reactNativeArtifactDaemonTransport = vi.hoisted(() => ({
    fetch: vi.fn(),
}));

vi.mock('@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead', () => ({
    createActivePluginAccountHostedArtifactSourceCandidate: (input: unknown) => (
        activeAccountHostedArtifactSource.create(input)
    ),
    createActivePluginAccountHostedArtifactTargetSourceCandidate: (input: unknown) => (
        activeAccountHostedArtifactSource.create(input)
    ),
    publishActivePluginAccountHostedArtifact: async () => ({ kind: 'published', value: { outcome: 'created' } }),
}));
vi.mock('./reactNativeArtifactDaemonTransport', () => ({
    fetchReactNativeExactArtifactBytesViaMachineRpc: reactNativeArtifactDaemonTransport.fetch,
}));

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactDigestV1Schema,
    PluginUiArtifactsManifestEntryV2Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import {
    createPluginReactNativeArtifactLeaseCacheSink,
    createPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type {
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import {
    createPluginAccountAvailabilityReader,
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import {
    acquirePluginReactNativeArtifactLease,
    materializePluginReactNativeArtifactLeaseInCache,
} from './reactNativeArtifactLease';
import {
    createPluginReactNativeArtifactAvailabilityProducer,
} from './reactNativeArtifactAvailability';
import { createBundledPluginUiAppExactArtifactSourceFromInventory } from './bundledAppExactArtifactSource';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

function createLifetime() {
    let retired = false;
    const listeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope,
        isCurrent: () => !retired,
        onRetire: (listener) => {
            listeners.add(listener);
            return Object.freeze({ dispose: () => listeners.delete(listener) });
        },
    });
    return Object.freeze({
        lifetime,
        retire: () => {
            retired = true;
            for (const listener of [...listeners]) listener();
        },
    });
}

const inactiveAccountHostedSource = Object.freeze({
    kind: 'accountHosted' as const,
    fetch: async () => null,
});
const inactiveAppExactSource = Object.freeze({
    kind: 'appExact' as const,
    fetch: async () => null,
});

let permanentlyCurrentLifetime = createLifetime().lifetime;

type ReactNativeLeaseTestInput = Omit<
    Parameters<typeof acquirePluginReactNativeArtifactLease>[0],
    'accountLifetime'
> & Readonly<{
    accountLifetime?: ActiveServerAccountScopeLifetime;
}>;

function acquire(input: ReactNativeLeaseTestInput) {
    const request = {
        ...input,
        accountLifetime: input.accountLifetime ?? permanentlyCurrentLifetime,
    };
    return acquirePluginReactNativeArtifactLease(request);
}

beforeEach(() => {
    permanentlyCurrentLifetime = createLifetime().lifetime;
    activeAccountHostedArtifactSource.create.mockReset();
    activeAccountHostedArtifactSource.create.mockReturnValue(inactiveAccountHostedSource);
});

function createPersistentStore() {
    const records = new Map<string, PluginUiPersistentArtifactRecord>();
    const keyFor = (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => (
        identity.artifactDigest
    );
    const reads = vi.fn(async (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => (
        records.get(keyFor(identity)) ?? null
    ));
    const writes = vi.fn(async (record: PluginUiPersistentArtifactRecord) => {
        records.set(keyFor(record.persistentIdentity), record);
        return 'persisted' as const;
    });
    const removes = vi.fn(async (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => {
        records.delete(keyFor(identity));
    });
    const removeAccount = vi.fn(async () => undefined);
    const store: PluginUiPersistentArtifactStore = {
        read: reads,
        write: writes,
        remove: removes,
        removeAccount,
    };
    return { records, store, reads, writes, removes, removeAccount };
}

function fixture(input: Readonly<{
    artifactContributionId?: string;
    accountHosted?: boolean;
    bundled?: boolean;
}> = {}) {
    const artifactContributionId = input.artifactContributionId ?? 'native-preview';
    const accountHosted = input.accountHosted ?? false;
    const entryPath = 'react-native/native-preview-artifact/entry.cjs.bundle';
    const entryBytes = new TextEncoder().encode('globalThis.__acmeEntry = true;');
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
            artifactId: 'native-preview-artifact',
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
            resources: [],
        },
    });
    const materialization: PluginMachineMaterializationV1 = {
        serverIdentityId: 'srv_account_one',
        machineId: 'machine-a',
        materializationId: 'install-epoch-a',
        pluginId: 'com.acme.preview',
        version: '1.2.3',
        sourceClass: input.bundled ? 'localPath' : 'versionedArchive',
        portableRelease: !input.bundled,
        ...(input.bundled ? {} : { archiveDigestSha256 }),
        uiArtifacts: [{
            contributionId: artifactContributionId,
            artifactId: 'native-preview-artifact',
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    const snapshot = {
            availabilityCursor: 7,
            intentReads: input.bundled ? [] : [{
                pluginId: materialization.pluginId,
                response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                    availabilityCursor: 7,
                    packageAssets: [],
                    hostingCapability: accountHosted
                        ? { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 }
                        : { enabled: false },
                    intent: {
                        pluginId: materialization.pluginId,
                        desiredVersion: materialization.version,
                        enabled: true,
                        offlineUiHosting: accountHosted ? 'enabled' : 'disabled',
                        writableCollections: [],
                        revision: 'intent-1',
                    },
                    release,
                    uiArtifacts: accountHosted
                        ? [{
                            release: { pluginId: materialization.pluginId, version: materialization.version },
                            contributionId: artifactContributionId,
                            artifactId: 'native-preview-artifact',
                            tier: 'reactNative' as const,
                            platform: 'ios' as const,
                            accountArtifactId: '00000000-0000-4000-8000-000000000001',
                            artifactDigest,
                            hostUiApiRange: '^1.0.0',
                        }]
                        : [],
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
        contributionId: 'native-preview',
        artifactId: 'native-preview-artifact',
        artifactDigest,
        platform: 'ios' as const,
    } satisfies PluginReactNativeBundleCacheIdentity;
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({
        artifactId: 'native-preview-artifact',
        tier: 'reactNative' as const,
        entry: entryPath,
        files,
        digest: artifactDigest,
        builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
        executable: { exports: ['renderSurface'] as const },
        hostUiApiRange: '^1.0.0',
    });
    const origin = {
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: {
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        },
    } as const;
    const daemonResponse = {
        ok: true as const,
        artifactFamily: 'reactNative' as const,
        cacheIdentity,
        artifact: {
            artifactKind: 'reactNativeBundle' as const,
            digest: artifactDigest,
            format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        bytesBase64: encodeBase64(entryBytes),
        files: [
            { ...files[0], bytesBase64: encodeBase64(entryBytes) },
        ],
    };
    return {
        snapshot,
        reader,
        cacheIdentity,
        graph,
        origin,
        daemonResponse,
        entryBytes,
        bytesByPath: new Map<string, Uint8Array>([
            [entryPath, entryBytes],
        ]),
    };
}

describe('React Native Artifact lease acquisition', () => {
    it.each(['mount', 'account'] as const)('settles %s retirement while the persistent write boundary is still pending', async (retirement) => {
        const current = fixture();
        const account = createLifetime();
        const cancellation = new AbortController();
        const persistent = createPersistentStore();
        let releaseWrite!: () => void;
        const heldWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
        let enteredWrite!: () => void;
        const writeEntered = new Promise<void>(resolve => { enteredWrite = resolve; });
        // Only physical storage and daemon transport are substituted. The real
        // producer, selected lease, integrity, custody and cache remain composed.
        const cache = createPluginReactNativeBundleCache({ persistentStore: {
            ...persistent.store,
            write: async record => {
                enteredWrite();
                await heldWrite;
                return persistent.store.write(record);
            },
        } });
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache, appExact: inactiveAppExactSource, fetchDaemonArtifactBytes,
        });
        const input = { reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: account.lifetime, signal: cancellation.signal, isCurrent: () => true,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId } };
        let settlement: Awaited<ReturnType<typeof producer.acquire>> | undefined;
        const pending = producer.acquire(input).then(result => { settlement = result; return result; });
        try {
            await writeEntered;
            if (retirement === 'mount') cancellation.abort();
            else account.retire();
            await vi.waitFor(() => expect(settlement).toMatchObject({ kind: 'unavailable', code: 'artifact_lease_revoked',
                layer: 'artifact', phase: 'preparation', retryable: false }));
            expect(cache.readInstalledArtifact(current.cacheIdentity)).toBeNull();
            expect(fetchDaemonArtifactBytes).toHaveBeenCalledTimes(1);
        } finally {
            releaseWrite();
            const result = await pending;
            if (result.kind === 'available') result.dispose();
        }
        // A new, genuinely current consumer still acquires the exact retained
        // bytes after the physical write settles, without repeating transport.
        const recovered = await producer.acquire({ ...input, accountLifetime: createLifetime().lifetime,
            signal: new AbortController().signal });
        expect(recovered.kind).toBe('available');
        expect(cache.readInstalledArtifact(current.cacheIdentity)?.bytes).toEqual(current.entryBytes);
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledTimes(1);
        if (recovered.kind === 'available') recovered.dispose();
    });

    it('reads immutable bytes once across mounted effects and reacquires after Account retirement', async () => {
        const current = fixture();
        const cache = createPluginReactNativeBundleCache();
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache, appExact: inactiveAppExactSource, fetchDaemonArtifactBytes,
        });
        let account = createLifetime();
        const mount = () => renderHook(() => {
            const [ready, setReady] = React.useState(false);
            React.useEffect(() => {
                let handle: Awaited<ReturnType<typeof producer.acquire>> | undefined;
                let mounted = true;
                void producer.acquire({
                    reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
                    accountLifetime: account.lifetime,
                    daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
                    isCurrent: () => mounted,
                }).then(value => { handle = value; setReady(value.kind === 'available'); });
                return () => { mounted = false; if (handle?.kind === 'available') handle.dispose(); };
            }, []);
            return ready;
        });
        for (let cohort = 0; cohort < 6; cohort++) {
            const hooks = [await mount(), await mount(), await mount()];
            for (const hook of hooks) {
                await vi.waitFor(() => expect(hook.getCurrent()).toBe(true));
                await hook.unmount();
            }
        }
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledTimes(1);
        expect(cache.readInstalledArtifact(current.cacheIdentity, { ...scope, accountId: 'another-account' })).toBeNull();
        await cache.removePersistentArtifact({ accountScope: scope, artifactDigest: current.cacheIdentity.artifactDigest });
        const evicted = await mount();
        await vi.waitFor(() => expect(evicted.getCurrent()).toBe(true));
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledTimes(2);
        await evicted.unmount();
        account.retire();
        await flushHookEffects();
        account = createLifetime();
        const next = await mount();
        await flushHookEffects();
        await vi.waitFor(() => expect(next.getCurrent()).toBe(true));
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledTimes(3);
        await next.unmount();
    });

    it('materializes the Account-selected digest from another supplier when the primary daemon misses', async () => {
        const current = fixture();
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: { ...current.snapshot, materializations: [], snapshots: [] },
        });
        const cache = createPluginReactNativeBundleCache();
        const primary = { machineId: 'unavailable-machine', serverId: scope.serverId };
        const supplier = { machineId: 'byte-supplier', serverId: 'another-home' };
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: inactiveAppExactSource,
            // The transport boundary varies; Account selection, verification and cache remain real.
            fetchDaemonArtifactBytes: async ({ transport }) => transport.machineId === supplier.machineId
                ? current.daemonResponse
                : { ok: false, code: 'artifact_unavailable', diagnostics: [] },
        });
        const input = {
            reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            isCurrent: () => true,
            daemon: primary,
        };

        expect((await producer.acquire(input)).kind).toBe('unavailable');
        const acquired = await producer.acquire({ ...input, daemons: [primary, supplier] });

        expect(acquired.kind).toBe('available');
        if (acquired.kind !== 'available') throw new Error('Expected the alternate supplier to satisfy the selected digest.');
        expect(cache.readInstalledArtifact(current.cacheIdentity)?.bytes).toEqual(current.entryBytes);
        expect(acquired.isCurrent()).toBe(true);
        acquired.dispose();
    });

    it('carries exact installed origin through the real RN producer, lease and cache without Account selection', async () => {
        const current = fixture();
        const response = current.snapshot.intentReads[0]!.response;
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { ...current.snapshot, releases: [response.release!],
            intentReads: [{ pluginId: current.cacheIdentity.pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                ...response, intent: null, release: null, uiArtifacts: [],
            }) }],
        } });
        const cache = createPluginReactNativeBundleCache();
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache, appExact: inactiveAppExactSource,
            // Only the daemon byte RPC is replaced; admission, custody, integrity and cache are real.
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        const input = { reader: store.bind(scope), artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime, isCurrent: () => true,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
        };
        // Mis-binding the producer's origin forwarding must refuse the identical byte request.
        expect(await producer.acquire(input)).toMatchObject({ kind: 'unavailable', code: 'artifact_not_current',
            layer: 'artifact', phase: 'preparation', retryable: false });
        const acquired = await producer.acquire({ ...input, executionOrigin: current.origin });
        expect(acquired.kind).toBe('available');
        if (acquired.kind !== 'available') throw new Error('Expected installed RN Artifact');
        expect(acquired.cacheKey).toEqual(expect.any(String));
        expect(acquired.isCurrent()).toBe(true);
        store.retire([current.cacheIdentity.pluginId]);
        expect(acquired.isCurrent()).toBe(false);
        acquired.dispose();
    });
    function daemonProjectionSelection() {
        return Object.freeze({
            occurrenceId: 'com.acme.preview-occurrence-a',
            contributionId: 'native-preview',
            releaseVersion: '1.2.3',
            isCurrent: () => true,
        });
    }

    it.each([false, true])('fetches the exact bundled daemon digest absent from the app and verifies its bytes (corrupt: %s)', async (corrupt) => {
        const current = fixture({ bundled: true });
        const readBundledAssetBytes = vi.fn(async () => current.entryBytes);
        const appExact = createBundledPluginUiAppExactArtifactSourceFromInventory({
            inventory: [{
                pluginId: current.cacheIdentity.pluginId,
                artifactId: current.cacheIdentity.artifactId,
                tier: 'reactNative',
                releaseVersion: '1.2.3',
                digest: `sha256:${'f'.repeat(64)}`,
                files: [{ relativePath: current.graph.entry, asset: 'older-app-entry' }],
            }],
            readBundledAssetBytes,
        });
        const fetchDaemonArtifactBytes = vi.fn(async () => corrupt ? {
            ...current.daemonResponse,
            files: current.daemonResponse.files.map((file) => ({
                ...file,
                bytesBase64: encodeBase64(new Uint8Array([1, 2, 3])),
            })),
        } : current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemonProjectionSelection: daemonProjectionSelection(),
            appExact,
            daemon: {
                machineId: current.origin.materializationRef.machineId,
                serverId: scope.serverId,
            },
            fetchDaemonArtifactBytes,
        });

        expect(readBundledAssetBytes).not.toHaveBeenCalled();
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledWith({
            transport: {
                machineId: current.origin.materializationRef.machineId,
                serverId: scope.serverId,
            },
            family: 'reactNative',
            digest: current.cacheIdentity.artifactDigest,
            signal: expect.any(AbortSignal),
        });
        if (corrupt) {
            expect(acquired.kind).toBe('unavailable');
        } else {
            expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
            if (acquired.kind === 'available') {
                expect(acquired.lease.artifact.digest).toBe(current.graph.digest);
                acquired.lease.dispose();
            }
        }
    });

    it('fetches an originless selection from its projecting daemon when no mount route is supplied (L2)', async () => {
        const current = fixture({ bundled: true });
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            appExact: inactiveAppExactSource,
            daemonProjectionSelection: {
                ...daemonProjectionSelection(),
                transport: { machineId: 'projecting-machine', serverId: scope.serverId },
            },
            fetchDaemonArtifactBytes,
        });

        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledWith({
            transport: { machineId: 'projecting-machine', serverId: scope.serverId },
            family: 'reactNative',
            digest: current.cacheIdentity.artifactDigest,
            signal: expect.any(AbortSignal),
        });
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('uses the generated artifact host API range as the daemon-projection selection fact', async () => {
        const current = fixture({ bundled: true });
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: {
                ...current.graph,
                hostUiApiRange: '^2.0.0',
            },
            cacheIdentity: current.cacheIdentity,
            daemonProjectionSelection: daemonProjectionSelection(),
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchDaemonArtifactBytes,
        });
        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledOnce();
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('rejects a cache identity for a different semantic contribution before fetching bytes', async () => {
        const current = fixture({ bundled: true });
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);

        await expect(acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: {
                ...current.cacheIdentity,
                contributionId: 'different-native-preview',
            },
            daemonProjectionSelection: daemonProjectionSelection(),
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchDaemonArtifactBytes,
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(fetchDaemonArtifactBytes).not.toHaveBeenCalled();
    });

    it('owns source and cache composition behind an opaque React Native Availability handle', async () => {
        const current = fixture();
        const cache = createPluginReactNativeBundleCache();
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes,
        });

        const acquired = await producer.acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            isCurrent: () => true,
        });

        expect(acquired).toMatchObject({ kind: 'available' });
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledWith({
            transport: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            family: 'reactNative',
            digest: current.cacheIdentity.artifactDigest,
            signal: expect.any(AbortSignal),
        });
        if (acquired.kind !== 'available') throw new Error('Fixture Availability handle was unavailable.');
        expect(acquired.cacheKey).toEqual(expect.any(String));
        expect(acquired.isCurrent()).toBe(true);
        expect(acquired).not.toHaveProperty('lease');
        acquired.dispose();
    });

    it('uses an app-packaged exact Inspector Artifact before the daemon source', async () => {
        const current = fixture();
        const cache = createPluginReactNativeBundleCache();
        const appExactRead = vi.fn(async () => current.bytesByPath);
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);
        const appExact = Object.freeze({
            kind: 'appExact' as const,
            fetch: appExactRead,
        });
        // The producer owns source order; this is its packaged-asset system
        // boundary, not a renderer-facing candidate.
        const dependencies = {
            getCache: () => cache,
            fetchDaemonArtifactBytes,
            appExact,
        };
        const producer = createPluginReactNativeArtifactAvailabilityProducer(dependencies);

        const acquired = await producer.acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            isCurrent: () => true,
        });

        expect(acquired).toMatchObject({ kind: 'available' });
        expect(appExactRead).toHaveBeenCalledTimes(1);
        expect(fetchDaemonArtifactBytes).not.toHaveBeenCalled();
        if (acquired.kind === 'available') acquired.dispose();
    });

    it('uses an app-packaged exact Artifact selected by an originless bundled projection', async () => {
        const current = fixture({ bundled: true });
        const cache = createPluginReactNativeBundleCache();
        const appExactRead = vi.fn(async () => current.bytesByPath);
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: Object.freeze({
                kind: 'appExact' as const,
                fetch: appExactRead,
            }),
            fetchDaemonArtifactBytes,
        });

        const acquired = await producer.acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            daemonProjectionSelection: daemonProjectionSelection(),
            isCurrent: () => true,
        });

        expect(acquired).toMatchObject({ kind: 'available' });
        expect(appExactRead).toHaveBeenCalledTimes(1);
        expect(fetchDaemonArtifactBytes).not.toHaveBeenCalled();
        if (acquired.kind === 'available') acquired.dispose();
    });

    it('constructs the active Account source inside the lease for a current Account-hosted cold load', async () => {
        const current = fixture({ accountHosted: true });
        const { lifetime } = createLifetime();
        const accountHostedCandidate = Object.freeze({
            kind: 'accountHosted' as const,
            fetch: vi.fn(async () => current.bytesByPath),
        });
        activeAccountHostedArtifactSource.create.mockReturnValue(accountHostedCandidate);

        const input = Object.freeze({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
        });
        const acquired = await acquire(input);

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'accountHosted' },
        });
        expect(activeAccountHostedArtifactSource.create).toHaveBeenCalledWith({ accountLifetime: lifetime });
    });

    it('reads a current verified persistent Artifact before contacting the exact daemon', async () => {
        const current = fixture();
        const persistent = createPersistentStore();
        const persistentIdentity = {
            accountScope: scope,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        persistent.records.set(`${persistentIdentity.artifactDigest}`, {
            persistentIdentity,
            bytes: current.entryBytes,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: current.entryBytes,
            })),
        });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'persistentCache' },
        });
        expect(fetchArtifactBytes).not.toHaveBeenCalled();
    });

    it('retains the semantic contribution alongside the generated artifact locator', async () => {
        const current = fixture();
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: {
                sourceKind: 'daemon',
                artifact: {
                    contributionId: 'native-preview',
                    artifactId: 'native-preview-artifact',
                },
            },
        });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            transport: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            family: 'reactNative',
            digest: current.cacheIdentity.artifactDigest,
            signal: expect.any(AbortSignal),
        });
    });

    it('dereferences daemon bytes by digest when non-digest client metadata changes', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        // Byte delivery is digest-addressed; renderer metadata remains local
        // admission context and is not echoed by the byte provider.
        const nonConformingIdentity = { ...current.cacheIdentity, expoRuntimeVersion: 'ignored-locally' };

        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: nonConformingIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => ({
                ...current.daemonResponse,
                cacheIdentity: current.cacheIdentity,
            }),
        });

        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('keeps an acquired daemon-sourced lease current after its daemon materialization disappears', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });

        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        if (acquired.kind !== 'available') throw new Error('unreachable');

        // The daemon that supplied the bytes goes away. The bytes are already
        // copied, integrity-verified and in host custody, and the Account's
        // current Artifact admission is unchanged, so the lease must survive.
        readerStore.replace({
            scope,
            snapshot: Object.freeze({ ...current.snapshot, materializations: Object.freeze([]) }),
        });

        expect(acquired.lease.isCurrent()).toBe(true);
        await expect(acquired.lease.readFile(current.graph.entry)).resolves.toMatchObject({
            kind: 'available',
        });
    });

    it('uses retained verified Artifact bytes without reacquiring them from the daemon', async () => {
        const current = fixture();
        const persistent = createPersistentStore();
        const persistentIdentity = {
            accountScope: scope,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        const corruptEntry = new Uint8Array(current.entryBytes);
        corruptEntry[0] = corruptEntry[0]! ^ 1;
        persistent.records.set(`${persistentIdentity.artifactDigest}`, {
            persistentIdentity,
            bytes: corruptEntry,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: corruptEntry,
            })),
        });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'persistentCache' },
        });
        if (acquired.kind !== 'available') throw new Error('Expected retained Artifact lease');
        await expect(acquired.lease.readFile(current.graph.entry)).resolves.toMatchObject({
            kind: 'available', bytes: corruptEntry,
        });
        acquired.lease.dispose();
        expect(persistent.reads).toHaveBeenCalledTimes(1);
        expect(persistent.removes).not.toHaveBeenCalled();
        expect(fetchArtifactBytes).not.toHaveBeenCalled();
        expect(persistent.writes).not.toHaveBeenCalled();
    });

    it('retires the lease without deleting the retained bytes when the Account disables the plugin', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const persistent = createPersistentStore();
        const persistentIdentity = {
            accountScope: scope,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        const neighboringIdentity = {
            ...persistentIdentity,
            artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'c'.repeat(64)}`),
        };
        const neighboringKey = `${neighboringIdentity.artifactDigest}`;
        persistent.records.set(neighboringKey, {
            persistentIdentity: neighboringIdentity,
            bytes: current.entryBytes,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: current.entryBytes,
            })),
        });

        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        if (acquired.kind !== 'available') throw new Error('Fixture lease was unavailable.');

        readerStore.replace({
            scope,
            snapshot: {
                ...current.snapshot,
                availabilityCursor: 8,
                intentReads: current.snapshot.intentReads.map((intentRead) => ({
                    ...intentRead,
                    response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                        ...intentRead.response,
                        availabilityCursor: 8,
                        intent: intentRead.response.intent
                            ? { ...intentRead.response.intent, enabled: false }
                            : null,
                    }),
                })),
            },
        });
        await Promise.resolve();

        expect(acquired.lease.isCurrent()).toBe(false);
        // Disable stops new use and retains the bounded archive (PEP-ARTIFACTS
        // 10.1). Physical deletion of a superseded or withdrawn identity belongs
        // to the Availability projection writer that holds both verified
        // snapshots, never to a per-surface lease reacting to currentness loss.
        // The exact identity this lease admitted is still stored, so re-enabling
        // the plugin reuses these verified bytes instead of re-downloading them.
        expect(
            persistent.records.get(`${persistentIdentity.artifactDigest}`)
                ?.persistentIdentity,
        ).toEqual(persistentIdentity);
        expect(persistent.removes).not.toHaveBeenCalled();
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.records.has(neighboringKey)).toBe(true);
    });

    it('reuses the exact persistent Artifact across semantic slot metadata changes', async () => {
        const current = fixture();
        const persistent = createPersistentStore();
        const persistentIdentity = {
            accountScope: scope,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        persistent.records.set(`${persistentIdentity.artifactDigest}`, {
            persistentIdentity,
            bytes: current.entryBytes,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: current.entryBytes,
            })),
        });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);
        const identityWithChangedSlotMetadata = {
            ...current.cacheIdentity,
            contributionId: 'replacement-renderer',
        };
        // The new semantic slot must be selected by its actual Account release;
        // digest cache reuse does not grant admission to an undeclared slot.
        const replacement = fixture({ artifactContributionId: identityWithChangedSlotMetadata.contributionId });

        const acquired = await acquire({
            reader: replacement.reader,
            artifactGraph: current.graph,
            cacheIdentity: identityWithChangedSlotMetadata,
            daemonProjectionSelection: {
                ...daemonProjectionSelection(),
                contributionId: identityWithChangedSlotMetadata.contributionId,
            },
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'persistentCache' },
        });
        expect(fetchArtifactBytes).not.toHaveBeenCalled();
        expect(persistent.removes).not.toHaveBeenCalled();
    });

    it('fetches an Account-release digest from the mount daemon without a matching materialization', async () => {
        // A daemon source is transport, not admission (AVD-03): the release
        // already selected the digest and the lease verifies the bytes.
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({
            scope,
            snapshot: Object.freeze({ ...current.snapshot, materializations: Object.freeze([]), snapshots: Object.freeze([]) }),
        });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: 'machine-without-materialization', serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        });

        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            transport: { machineId: 'machine-without-materialization', serverId: scope.serverId },
            family: 'reactNative',
            digest: current.cacheIdentity.artifactDigest,
            signal: expect.any(AbortSignal),
        });
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('persists only the fully verified daemon file set for a still-current Account scope', async () => {
        const current = fixture();
        const persistent = createPersistentStore();

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'daemon' },
        });
        expect(persistent.writes).toHaveBeenCalledTimes(1);
        const record = persistent.writes.mock.calls[0]?.[0];
        expect(record).toMatchObject({
            persistentIdentity: expect.objectContaining({
                accountScope: scope,
                artifactDigest: current.cacheIdentity.artifactDigest,
            }),
            entryRelativePath: current.graph.entry,
        });
        expect(record.files).toHaveLength(1);
    });

    it('hands only the current complete verified lease to the renderer cache sink', async () => {
        const current = fixture();
        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        if (acquired.kind !== 'available') throw new Error('Fixture lease was unavailable.');
        let consumerCurrent = true;
        const writeVerifiedArtifact = vi.fn(() => ({ ok: true as const, cacheKey: 'native-cache-key' }));

        const materialized = await materializePluginReactNativeArtifactLeaseInCache({
            lease: acquired.lease,
            cacheIdentity: current.cacheIdentity,
            accountScope: scope,
            cacheSink: { writeVerifiedArtifact },
            isCurrent: () => consumerCurrent,
        });

        expect(materialized).toMatchObject({
            kind: 'available',
            cacheKey: 'native-cache-key',
        });
        expect(writeVerifiedArtifact).toHaveBeenCalledWith(expect.objectContaining({
            identity: current.cacheIdentity,
            accountScope: scope,
            entryRelativePath: current.graph.entry,
            bytes: current.entryBytes,
            files: expect.arrayContaining([
                expect.objectContaining({ relativePath: current.graph.entry, bytes: current.entryBytes }),
            ]),
        }));
        if (materialized.kind !== 'available') throw new Error('Expected cache handoff to succeed.');
        expect(materialized.isCurrent()).toBe(true);
        consumerCurrent = false;
        expect(materialized.isCurrent()).toBe(false);
    });

    it('leaves the cache holding its own bytes when the handed-over lease buffers are mutated afterwards', async () => {
        // The handoff no longer copies the lease's already-detached read bytes:
        // the cache sink is the owner that takes custody. This states that
        // contract from the outside, so removing the cache's own copy is a
        // failure here rather than a silent alias between the two owners.
        const current = fixture();
        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        if (acquired.kind !== 'available') throw new Error('Fixture lease was unavailable.');
        const handedOver: Uint8Array[] = [];
        const cache = createPluginReactNativeBundleCache();
        const cacheSink = createPluginReactNativeArtifactLeaseCacheSink({
            cache,
            lifetime: permanentlyCurrentLifetime,
        });

        const materialized = await materializePluginReactNativeArtifactLeaseInCache({
            lease: Object.freeze({
                ...acquired.lease,
                readFile: async (relativePath: string) => {
                    const read = await acquired.lease.readFile(relativePath);
                    if (read.kind === 'available') handedOver.push(read.bytes);
                    return read;
                },
            }),
            cacheIdentity: current.cacheIdentity,
            accountScope: scope,
            cacheSink,
            isCurrent: () => true,
        });
        expect(materialized).toMatchObject({ kind: 'available' });
        expect(handedOver).toHaveLength(1);

        for (const bytes of handedOver) bytes.fill(0);

        const cached = cache.readInstalledArtifact(current.cacheIdentity);
        expect(cached?.bytes).toEqual(current.entryBytes);
        expect(cached?.files?.map((file) => file.bytes)).toEqual([current.entryBytes]);
    });

    it('does not write a lease after the renderer consumer retires during its file handoff', async () => {
        const current = fixture();
        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        if (acquired.kind !== 'available') throw new Error('Fixture lease was unavailable.');
        let releaseRead!: () => void;
        const readBlocked = new Promise<void>((resolve) => { releaseRead = resolve; });
        let consumerCurrent = true;
        const readFile = vi.fn(async (relativePath: string) => {
            await readBlocked;
            return await acquired.lease.readFile(relativePath);
        });
        const writeVerifiedArtifact = vi.fn(() => ({ ok: true as const, cacheKey: 'stale-cache-key' }));
        const materializing = materializePluginReactNativeArtifactLeaseInCache({
            lease: Object.freeze({ ...acquired.lease, readFile }),
            cacheIdentity: current.cacheIdentity,
            accountScope: scope,
            cacheSink: { writeVerifiedArtifact },
            isCurrent: () => consumerCurrent,
        });

        consumerCurrent = false;
        releaseRead();

        await expect(materializing).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_lease_revoked',
        });
        expect(writeVerifiedArtifact).not.toHaveBeenCalled();
    });
});
