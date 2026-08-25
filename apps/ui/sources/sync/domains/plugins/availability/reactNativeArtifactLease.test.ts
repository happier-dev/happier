import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));
vi.mock('./reactNativeArtifactDaemonTransport', () => ({
    fetchReactNativeExactArtifactBytesViaMachineRpc: reactNativeArtifactDaemonTransport.fetch,
}));

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';
import type { DaemonPluginReactNativeCrashBindingTokenV1 } from '@happier-dev/protocol';

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
    readFile: async () => null,
});
const inactiveAppExactSource = Object.freeze({
    kind: 'appExact' as const,
    readFile: async () => null,
});

const permanentlyCurrentLifetime = createLifetime().lifetime;

function createCrashStateToken(
    identity: PluginReactNativeBundleCacheIdentity,
): DaemonPluginReactNativeCrashBindingTokenV1 {
    return Object.freeze({
        mount: Object.freeze({
            kind: 'destination' as const,
            destination: Object.freeze({ pluginId: identity.pluginId, localId: 'native-destination' }),
        }),
        renderer: Object.freeze({ pluginId: identity.pluginId, localId: identity.contributionId }),
        artifactDigest: identity.artifactDigest,
        crashStateEpoch: 4,
    });
}

function createComposerCrashStateToken(
    identity: PluginReactNativeBundleCacheIdentity,
): DaemonPluginReactNativeCrashBindingTokenV1 {
    return Object.freeze({
        mount: Object.freeze({
            kind: 'composer' as const,
            contribution: Object.freeze({ pluginId: identity.pluginId, localId: 'composer-region' }),
            immutableGenerationId: 'composer-generation-7',
            role: 'region' as const,
        }),
        renderer: Object.freeze({ pluginId: identity.pluginId, localId: identity.contributionId }),
        artifactDigest: identity.artifactDigest,
        crashStateEpoch: 4,
    });
}

type ReactNativeLeaseTestInput = Omit<
    Extract<
        Parameters<typeof acquirePluginReactNativeArtifactLease>[0],
        Readonly<{ artifactOwnerKind: 'renderer' }>
    >,
    'accountLifetime' | 'artifactOwnerKind' | 'crashStateToken'
> & Readonly<{
    accountLifetime?: ActiveServerAccountScopeLifetime;
    crashStateToken?: DaemonPluginReactNativeCrashBindingTokenV1;
}>;

function acquire(input: ReactNativeLeaseTestInput) {
    const request = {
        ...input,
        accountLifetime: input.accountLifetime ?? permanentlyCurrentLifetime,
        artifactOwnerKind: 'renderer' as const,
        crashStateToken: input.crashStateToken ?? createCrashStateToken(input.cacheIdentity),
    };
    return acquirePluginReactNativeArtifactLease(request);
}

beforeEach(() => {
    activeAccountHostedArtifactSource.create.mockReset();
    activeAccountHostedArtifactSource.create.mockReturnValue(inactiveAccountHostedSource);
});

function createPersistentStore() {
    const records = new Map<string, PluginUiPersistentArtifactRecord>();
    const keyFor = (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => (
        `${identity.releaseVersion}:${identity.artifactDigest}`
    );
    const reads = vi.fn(async (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => (
        records.get(keyFor(identity)) ?? null
    ));
    const writes = vi.fn(async (record: PluginUiPersistentArtifactRecord) => {
        records.set(keyFor(record.persistentIdentity), record);
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
}> = {}) {
    const artifactContributionId = input.artifactContributionId ?? 'native-preview';
    const accountHosted = input.accountHosted ?? false;
    const entryPath = 'react-native/acme/ios.bundle';
    const chunkPath = 'react-native/acme/chunk.js';
    const entryBytes = new TextEncoder().encode('globalThis.__acmeEntry = true;');
    const chunkBytes = new TextEncoder().encode('globalThis.__acmeChunk = true;');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
        {
            relativePath: chunkPath,
            digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
            byteSize: chunkBytes.byteLength,
        },
    ] as const;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
        { relativePath: chunkPath, bytes: chunkBytes },
    ]);
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
    // Portable release facts retain only generated artifact compatibility.
    // Current host/channel/capability facts belong to the transient link and
    // renderer adoption identity below.
    const compatibility = {
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
    };
    const adoptionCompatibility = {
        ...compatibility,
        hostAppVersion: '2.0.0',
        platform: 'ios' as const,
        channel: 'internal',
        nativeCapabilities: [],
    };
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
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            compatibility,
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
        sourceClass: 'versionedArchive',
        portableRelease: true,
        archiveDigestSha256,
        uiArtifacts: [{
            contributionId: artifactContributionId,
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
        }],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    const snapshot = {
            availabilityCursor: 7,
            intentReads: [{
                pluginId: materialization.pluginId,
                response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                    availabilityCursor: 7,
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
                            tier: 'reactNative' as const,
                            platform: adoptionCompatibility.platform,
                            artifactId: '00000000-0000-4000-8000-000000000001',
                            artifactDigest,
                            compatibility: adoptionCompatibility,
                        }]
                        : [],
                }),
            }],
            materializations: [materialization],
            snapshots: [{
                serverIdentityId: materialization.serverIdentityId,
                machineId: materialization.machineId,
                revision: 1,
                materializations: [materialization],
            }],
    } satisfies PluginAccountAvailabilitySnapshot;
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot });
    const cacheIdentity = {
        pluginId: materialization.pluginId,
        contributionId: 'native-preview',
        artifactDigest,
        hostAppVersion: adoptionCompatibility.hostAppVersion,
        hostUiApiVersion: compatibility.hostUiApiVersion,
        reactVersion: compatibility.reactVersion,
        reactNativeVersion: compatibility.reactNativeVersion,
        expoRuntimeVersion: compatibility.expoRuntimeVersion,
        hermesVersion: compatibility.hermesVersion,
        platform: adoptionCompatibility.platform,
        channel: adoptionCompatibility.channel,
        nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
        projectionGeneration: 12,
    } satisfies PluginReactNativeBundleCacheIdentity;
    const crashStateToken = createCrashStateToken(cacheIdentity);
    const graph = {
        contributionId: artifactContributionId,
        tier: 'reactNative' as const,
        platform: cacheIdentity.platform,
        entry: entryPath,
        files,
        digest: artifactDigest,
        builtWith: { bundler: 'repack' as const, version: '5.0.0' },
        repack: { containerName: 'acme_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
        hostUiApiVersion: cacheIdentity.hostUiApiVersion,
        compat: { react: cacheIdentity.reactVersion, reactNative: cacheIdentity.reactNativeVersion },
    };
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
        artifactOwnerKind: 'renderer' as const,
        cacheIdentity,
        crashStateToken,
        artifact: {
            pluginId: cacheIdentity.pluginId,
            contributionId: cacheIdentity.contributionId,
            artifactKind: 'reactNativeBundle' as const,
            digest: artifactDigest,
            format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        bytesBase64: encodeBase64(entryBytes),
        files: [
            { ...files[0], bytesBase64: encodeBase64(entryBytes) },
            { ...files[1], bytesBase64: encodeBase64(chunkBytes) },
        ],
    };
    return {
        snapshot,
        reader,
        cacheIdentity,
        crashStateToken,
        graph,
        origin,
        daemonResponse,
        entryBytes,
        chunkBytes,
        bytesByPath: new Map<string, Uint8Array>([
            [entryPath, entryBytes],
            [chunkPath, chunkBytes],
        ]),
    };
}

describe('React Native Artifact lease acquisition', () => {
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
            artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
            },
            isCurrent: () => true,
        });

        expect(acquired).toMatchObject({ kind: 'available' });
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledWith({
            origin: current.origin,
            serverId: scope.serverId,
            identity: current.cacheIdentity,
            artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
        });
        if (acquired.kind !== 'available') throw new Error('Fixture Availability handle was unavailable.');
        expect(acquired.cacheKey).toEqual(expect.any(String));
        expect(acquired.isCurrent()).toBe(true);
        expect(acquired).not.toHaveProperty('lease');
        acquired.dispose();
    });

    it('keeps a client Action anchored to its exact Action identity instead of coercing it into Voice', async () => {
        const current = fixture({ artifactContributionId: 'client-action-bundle' });
        const clientContribution = {
            family: 'actions',
            action: { pluginId: current.cacheIdentity.pluginId, localId: 'open-preview' },
        } as const;
        const actionIdentity = {
            ...current.cacheIdentity,
            contributionId: clientContribution.action.localId,
        } as const;
        const daemonResponse = {
            ...current.daemonResponse,
            artifactOwnerKind: 'clientContribution' as const,
            cacheIdentity: actionIdentity,
            clientContribution,
            artifact: {
                ...current.daemonResponse.artifact,
                contributionId: clientContribution.action.localId,
            },
        };
        const cache = createPluginReactNativeBundleCache();
        const fetchDaemonArtifactBytes = vi.fn(async () => daemonResponse);
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes,
        });

        const acquired = await producer.acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: actionIdentity,
            accountLifetime: permanentlyCurrentLifetime,
            artifactOwnerKind: 'clientContribution',
            clientContribution,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
            },
            isCurrent: () => true,
        });

        expect(acquired).toMatchObject({ kind: 'available' });
        expect(fetchDaemonArtifactBytes).toHaveBeenCalledWith({
            origin: current.origin,
            serverId: scope.serverId,
            identity: actionIdentity,
            artifactOwnerKind: 'clientContribution',
            clientContribution,
        });
        if (acquired.kind === 'available') acquired.dispose();
    });

    it('uses an app-packaged exact Inspector Artifact before the daemon source', async () => {
        const current = fixture();
        const cache = createPluginReactNativeBundleCache();
        const appExactRead = vi.fn(async ({ relativePath }: Readonly<{ relativePath: string }>) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);
        const appExact = Object.freeze({
            kind: 'appExact' as const,
            readFile: appExactRead,
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
            artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
            },
            isCurrent: () => true,
        });

        expect(acquired).toMatchObject({ kind: 'available' });
        expect(appExactRead).toHaveBeenCalledTimes(current.graph.files.length);
        expect(fetchDaemonArtifactBytes).not.toHaveBeenCalled();
        if (acquired.kind === 'available') acquired.dispose();
    });

    it('constructs the active Account source inside the lease for a current Account-hosted cold load', async () => {
        const current = fixture({ accountHosted: true });
        const { lifetime } = createLifetime();
        const accountHostedCandidate = Object.freeze({
            kind: 'accountHosted' as const,
            readFile: vi.fn(async ({ relativePath }: Readonly<{ relativePath: string }>) => (
                current.bytesByPath.get(relativePath) ?? null
            )),
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
            releaseVersion: '1.2.3',
            pluginId: current.cacheIdentity.pluginId,
            contributionId: current.cacheIdentity.contributionId,
            tier: 'reactNative' as const,
            platform: current.cacheIdentity.platform,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        persistent.records.set(`${persistentIdentity.releaseVersion}:${persistentIdentity.artifactDigest}`, {
            persistentIdentity,
            bytes: current.entryBytes,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: file.relativePath === current.graph.entry ? current.entryBytes : current.chunkBytes,
            })),
        });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes,
            },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'persistentCache' },
        });
        expect(fetchArtifactBytes).not.toHaveBeenCalled();
    });

    it('uses the exact generated Account slot while daemon bytes retain the renderer contribution identity', async () => {
        const current = fixture({ artifactContributionId: 'generated-native-slot' });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes,
            },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: {
                sourceKind: 'daemon',
                artifact: { contributionId: 'generated-native-slot' },
            },
        });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            origin: current.origin,
            serverId: scope.serverId,
            identity: current.cacheIdentity,
            artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
        });
    });

    it('refuses daemon bytes for a cache identity that does not conform to the canonical Protocol schema', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        // An empty optional compatibility coordinate is not the canonical
        // "absent" value; it must not be coerced into matching daemon bytes
        // whose identity omits the field.
        const nonConformingIdentity = { ...current.cacheIdentity, expoRuntimeVersion: '' };
        const { expoRuntimeVersion: _omitted, ...daemonCacheIdentity } = current.cacheIdentity;

        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: nonConformingIdentity,
            crashStateToken: createCrashStateToken(nonConformingIdentity),
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: async () => ({
                    ...current.daemonResponse,
                    cacheIdentity: daemonCacheIdentity,
                }),
            },
        });

        expect(acquired).toEqual({ kind: 'unavailable', code: 'artifact_source_unavailable' });
    });

    it('keeps an acquired daemon-sourced lease current after its daemon materialization disappears', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });

        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: async () => current.daemonResponse,
            },
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

    it('rejects daemon bytes whose echoed crash token is stale even when their artifact identity matches', async () => {
        const current = fixture();
        const staleResponse = {
            ...current.daemonResponse,
            crashStateToken: {
                ...current.crashStateToken,
                crashStateEpoch: current.crashStateToken.crashStateEpoch + 1,
            },
        };
        const fetchArtifactBytes = vi.fn(async () => staleResponse);

        const request = {
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            crashStateToken: current.crashStateToken,
            artifactOwnerKind: 'renderer' as const,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes,
            },
            accountLifetime: permanentlyCurrentLifetime,
        };

        await expect(acquirePluginReactNativeArtifactLease(request)).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_source_unavailable',
        });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            origin: current.origin,
            serverId: scope.serverId,
            identity: current.cacheIdentity,
            artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
        });
    });

    it('keeps Composer crash bindings exact while materializing daemon bytes into a lease', async () => {
        const current = fixture();
        const composerCrashStateToken = createComposerCrashStateToken(current.cacheIdentity);
        const currentResponse = {
            ...current.daemonResponse,
            crashStateToken: composerCrashStateToken,
        };
        const fetchCurrentArtifactBytes = vi.fn(async () => currentResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            crashStateToken: composerCrashStateToken,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: fetchCurrentArtifactBytes,
            },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'daemon' },
        });
        if (acquired.kind !== 'available') throw new Error('Expected a current Composer Artifact lease.');
        acquired.lease.dispose();

        const staleComposerResponse = {
            ...currentResponse,
            crashStateToken: {
                ...composerCrashStateToken,
                mount: {
                    ...composerCrashStateToken.mount,
                    immutableGenerationId: 'stale-composer-generation',
                },
            },
        };
        const fetchStaleArtifactBytes = vi.fn(async () => staleComposerResponse);

        await expect(acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            crashStateToken: composerCrashStateToken,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: fetchStaleArtifactBytes,
            },
        })).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_source_unavailable',
        });
    });

    it('evicts one corrupt persistent Artifact identity before falling back to its exact daemon', async () => {
        const current = fixture();
        const persistent = createPersistentStore();
        const persistentIdentity = {
            accountScope: scope,
            releaseVersion: '1.2.3',
            pluginId: current.cacheIdentity.pluginId,
            contributionId: current.cacheIdentity.contributionId,
            tier: 'reactNative' as const,
            platform: current.cacheIdentity.platform,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        const corruptEntry = new Uint8Array(current.entryBytes);
        corruptEntry[0] = corruptEntry[0]! ^ 1;
        persistent.records.set(`${persistentIdentity.releaseVersion}:${persistentIdentity.artifactDigest}`, {
            persistentIdentity,
            bytes: corruptEntry,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: file.relativePath === current.graph.entry ? corruptEntry : current.chunkBytes,
            })),
        });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes,
            },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'daemon' },
        });
        expect(persistent.reads).toHaveBeenCalledBefore(fetchArtifactBytes);
        expect(persistent.removes).toHaveBeenCalledWith(persistentIdentity);
        expect(fetchArtifactBytes).toHaveBeenCalledTimes(1);
        expect(persistent.writes).toHaveBeenCalledTimes(1);
    });

    it('retires the lease without deleting the retained bytes when the Account disables the plugin', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const persistent = createPersistentStore();
        const persistentIdentity = {
            accountScope: scope,
            releaseVersion: '1.2.3',
            pluginId: current.cacheIdentity.pluginId,
            contributionId: current.cacheIdentity.contributionId,
            tier: 'reactNative' as const,
            platform: current.cacheIdentity.platform,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        const neighboringIdentity = {
            ...persistentIdentity,
            artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'c'.repeat(64)}`),
        };
        const neighboringKey = `${neighboringIdentity.releaseVersion}:${neighboringIdentity.artifactDigest}`;
        persistent.records.set(neighboringKey, {
            persistentIdentity: neighboringIdentity,
            bytes: current.entryBytes,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: file.relativePath === current.graph.entry ? current.entryBytes : current.chunkBytes,
            })),
        });

        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: async () => current.daemonResponse,
            },
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
            persistent.records.get(`${persistentIdentity.releaseVersion}:${persistentIdentity.artifactDigest}`)
                ?.persistentIdentity,
        ).toEqual(persistentIdentity);
        expect(persistent.removes).not.toHaveBeenCalled();
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.records.has(neighboringKey)).toBe(true);
    });

    it('reuses the exact persistent Artifact across renderer compatibility and generation replacement', async () => {
        const current = fixture();
        const persistent = createPersistentStore();
        const persistentIdentity = {
            accountScope: scope,
            releaseVersion: '1.2.3',
            pluginId: current.cacheIdentity.pluginId,
            contributionId: current.cacheIdentity.contributionId,
            tier: 'reactNative' as const,
            platform: current.cacheIdentity.platform,
            artifactDigest: current.cacheIdentity.artifactDigest,
        };
        persistent.records.set(`${persistentIdentity.releaseVersion}:${persistentIdentity.artifactDigest}`, {
            persistentIdentity,
            bytes: current.entryBytes,
            entryRelativePath: current.graph.entry,
            files: current.daemonResponse.files.map((file) => ({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                bytes: file.relativePath === current.graph.entry ? current.entryBytes : current.chunkBytes,
            })),
        });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: {
                ...current.cacheIdentity,
                channel: 'beta',
                nativeCapabilitiesDigest: `sha256:${'d'.repeat(64)}`,
                projectionGeneration: current.cacheIdentity.projectionGeneration + 1,
            },
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes,
            },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'persistentCache' },
        });
        expect(fetchArtifactBytes).not.toHaveBeenCalled();
        expect(persistent.removes).not.toHaveBeenCalled();
    });

    it('does not turn a same-machine replacement into a daemon source fallback', async () => {
        const current = fixture();
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        await expect(acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: {
                origin: {
                    ...current.origin,
                    materializationRef: {
                        ...current.origin.materializationRef,
                        materializationId: 'reinstalled-after-selection',
                    },
                },
                serverId: scope.serverId,
                fetchArtifactBytes,
            },
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_source_unavailable' });
        expect(fetchArtifactBytes).not.toHaveBeenCalled();
    });

    it('persists only the fully verified daemon file set for a still-current Account scope', async () => {
        const current = fixture();
        const persistent = createPersistentStore();

        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: { scope, store: persistent.store, isCurrent: () => true, removePersistentArtifact: persistent.removes },
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: async () => current.daemonResponse,
            },
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
                releaseVersion: '1.2.3',
                artifactDigest: current.cacheIdentity.artifactDigest,
            }),
            entryRelativePath: current.graph.entry,
        });
        expect(record.files).toHaveLength(2);
    });

    it('hands only the current complete verified lease to the renderer cache sink', async () => {
        const current = fixture();
        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: async () => current.daemonResponse,
            },
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
                expect.objectContaining({ relativePath: 'react-native/acme/chunk.js', bytes: current.chunkBytes }),
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
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: async () => current.daemonResponse,
            },
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
        expect(handedOver).toHaveLength(2);

        for (const bytes of handedOver) bytes.fill(0);

        const cached = cache.readInstalledArtifact(current.cacheIdentity);
        expect(cached?.bytes).toEqual(current.entryBytes);
        expect(cached?.files?.map((file) => file.bytes)).toEqual([current.entryBytes, current.chunkBytes]);
    });

    it('does not write a lease after the renderer consumer retires during its file handoff', async () => {
        const current = fixture();
        const acquired = await acquire({
            reader: current.reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes: async () => current.daemonResponse,
            },
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
