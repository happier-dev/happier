import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
    calls: [] as Array<{ fn: string; bytes: number; ms: number }>,
    reset() { probe.calls.length = 0; },
    report(label: string) {
        const byFn = new Map<string, { n: number; bytes: number; ms: number }>();
        for (const c of probe.calls) {
            const e = byFn.get(c.fn) ?? { n: 0, bytes: 0, ms: 0 };
            e.n += 1; e.bytes += c.bytes; e.ms += c.ms;
            byFn.set(c.fn, e);
        }
        const total = probe.calls.reduce((a, c) => ({ n: a.n + 1, bytes: a.bytes + c.bytes, ms: a.ms + c.ms }), { n: 0, bytes: 0, ms: 0 });
        // eslint-disable-next-line no-console
        console.log(`\n### ${label}`);
        for (const [fn, e] of byFn) {
            // eslint-disable-next-line no-console
            console.log(`  ${fn}: passes=${e.n} bytesHashed=${(e.bytes / 1048576).toFixed(2)}MiB ms=${e.ms.toFixed(1)}`);
        }
        // eslint-disable-next-line no-console
        console.log(`  TOTAL: passes=${total.n} bytesHashed=${(total.bytes / 1048576).toFixed(2)}MiB ms=${total.ms.toFixed(1)}`);
        return total;
    },
}));

vi.mock('@happier-dev/protocol/plugins/ui', async (importOriginal) => {
    const original = await importOriginal<typeof import('@happier-dev/protocol/plugins/ui')>();
    const wrap = <A extends unknown[], R>(name: string, fn: (...a: A) => R, size: (...a: A) => number) => (...a: A): R => {
        const t = performance.now();
        const r = fn(...a);
        probe.calls.push({ fn: name, bytes: size(...a), ms: performance.now() - t });
        return r;
    };
    return {
        ...original,
        computePluginUiArtifactSha256DigestV1: wrap(
            'computeBytesDigest',
            original.computePluginUiArtifactSha256DigestV1,
            (bytes: Uint8Array) => bytes.byteLength,
        ),
        verifyPluginUiArtifactBytesIntegrityV1: wrap(
            'verifyBytes',
            original.verifyPluginUiArtifactBytesIntegrityV1,
            (input: { bytes: Uint8Array }) => input.bytes.byteLength,
        ),
        verifyPluginUiArtifactFileSetIntegrityV1: wrap(
            'verifyFileSet',
            original.verifyPluginUiArtifactFileSetIntegrityV1,
            (input: { files: readonly { bytes: Uint8Array }[] }) => input.files.reduce((a, f) => a + f.bytes.byteLength, 0),
        ),
        computePluginUiArtifactFileSetSha256DigestV1: wrap(
            'computeFileSetDigest',
            original.computePluginUiArtifactFileSetSha256DigestV1,
            (files: readonly { bytes: Uint8Array }[]) => files.reduce((a, f) => a + f.bytes.byteLength, 0),
        ),
    };
});

const activeAccountHostedArtifactSource = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead', () => ({
    createActivePluginAccountHostedArtifactSourceCandidate: (input: unknown) => activeAccountHostedArtifactSource.create(input),
}));
vi.mock('./reactNativeArtifactDaemonTransport', () => ({
    fetchReactNativeExactArtifactBytesViaMachineRpc: vi.fn(),
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

import { encodeBase64 } from '@/encryption/base64';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type {
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import { createPluginAccountAvailabilityReader, type PluginAccountAvailabilitySnapshot } from './reader';
import { createPluginReactNativeArtifactAvailabilityProducer } from './reactNativeArtifactAvailability';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const permanentlyCurrentLifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const inactiveAppExactSource = Object.freeze({ kind: 'appExact' as const, readFile: async () => null });
const inactiveAccountHostedSource = Object.freeze({ kind: 'accountHosted' as const, readFile: async () => null });

// Realistic Re.Pack RN plugin bundle: ~3 MiB entry + ~1 MiB async chunk.
const ENTRY_BYTES_SIZE = 3 * 1024 * 1024;
const CHUNK_BYTES_SIZE = 1 * 1024 * 1024;

function pseudoJsBytes(size: number, seed: number): Uint8Array {
    const out = new Uint8Array(size);
    let x = seed >>> 0;
    for (let i = 0; i < size; i += 1) {
        x = (x * 1664525 + 1013904223) >>> 0;
        out[i] = 32 + (x % 94);
    }
    return out;
}

function createPersistentStore() {
    const records = new Map<string, PluginUiPersistentArtifactRecord>();
    const keyFor = (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => (
        `${identity.releaseVersion}:${identity.artifactDigest}`
    );
    const store: PluginUiPersistentArtifactStore = {
        read: async (identity) => records.get(keyFor(identity)) ?? null,
        write: async (record) => { records.set(keyFor(record.persistentIdentity), record); },
        remove: async (identity) => { records.delete(keyFor(identity)); },
        removeAccount: async () => undefined,
    };
    return { records, store };
}

function fixture() {
    const artifactContributionId = 'native-preview';
    const entryPath = 'react-native/acme/ios.bundle';
    const chunkPath = 'react-native/acme/chunk.js';
    const entryBytes = pseudoJsBytes(ENTRY_BYTES_SIZE, 1);
    const chunkBytes = pseudoJsBytes(CHUNK_BYTES_SIZE, 2);
    const files = [
        { relativePath: entryPath, digest: computePluginUiArtifactSha256DigestV1(entryBytes), byteSize: entryBytes.byteLength },
        { relativePath: chunkPath, digest: computePluginUiArtifactSha256DigestV1(chunkBytes), byteSize: chunkBytes.byteLength },
    ] as const;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
        { relativePath: chunkPath, bytes: chunkBytes },
    ]);
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
    const compatibility = {
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
    };
    const adoptionCompatibility = { ...compatibility, hostAppVersion: '2.0.0', platform: 'ios' as const, channel: 'internal', nativeCapabilities: [] };
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId: 'com.acme.preview', version: '1.2.3' },
        archiveDigestSha256,
        normalizedManifest: {
            schemaVersion: 2, id: 'com.acme.preview', version: '1.2.3', displayName: 'Acme preview',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {},
        },
        collectionContracts: [],
        uiSlots: [{ contributionId: artifactContributionId, tier: 'reactNative', platform: 'ios', artifactDigest, compatibility }],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] },
    });
    const materialization: PluginMachineMaterializationV1 = {
        serverIdentityId: 'srv_account_one', machineId: 'machine-a', materializationId: 'install-epoch-a',
        pluginId: 'com.acme.preview', version: '1.2.3', sourceClass: 'versionedArchive', portableRelease: true,
        archiveDigestSha256,
        uiArtifacts: [{ contributionId: artifactContributionId, tier: 'reactNative', platform: 'ios', artifactDigest }],
        enabled: true, trustState: 'trusted', observedAt: 1,
    };
    const snapshot = {
        availabilityCursor: 7,
        intentReads: [{
            pluginId: materialization.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                availabilityCursor: 7,
                hostingCapability: { enabled: false },
                intent: {
                    pluginId: materialization.pluginId, desiredVersion: materialization.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1',
                },
                release,
                uiArtifacts: [],
            }),
        }],
        materializations: [materialization],
    } satisfies PluginAccountAvailabilitySnapshot;
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot });
    const cacheIdentity = {
        pluginId: materialization.pluginId, contributionId: 'native-preview', artifactDigest,
        hostAppVersion: adoptionCompatibility.hostAppVersion, hostUiApiVersion: compatibility.hostUiApiVersion,
        reactVersion: compatibility.reactVersion, reactNativeVersion: compatibility.reactNativeVersion,
        expoRuntimeVersion: compatibility.expoRuntimeVersion, hermesVersion: compatibility.hermesVersion,
        platform: adoptionCompatibility.platform, channel: adoptionCompatibility.channel,
        nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`, projectionGeneration: 12,
    } satisfies PluginReactNativeBundleCacheIdentity;
    const crashStateToken = Object.freeze({
        mount: Object.freeze({ kind: 'destination' as const, destination: Object.freeze({ pluginId: cacheIdentity.pluginId, localId: 'native-destination' }) }),
        renderer: Object.freeze({ pluginId: cacheIdentity.pluginId, localId: cacheIdentity.contributionId }),
        artifactDigest: cacheIdentity.artifactDigest,
        crashStateEpoch: 4,
    });
    const graph = {
        contributionId: artifactContributionId, tier: 'reactNative' as const, platform: cacheIdentity.platform,
        entry: entryPath, files, digest: artifactDigest,
        builtWith: { bundler: 'repack' as const, version: '5.0.0' },
        repack: { containerName: 'acme_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
        hostUiApiVersion: cacheIdentity.hostUiApiVersion,
        compat: { react: cacheIdentity.reactVersion, reactNative: cacheIdentity.reactNativeVersion },
    };
    const origin = {
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: { machineId: materialization.machineId, materializationId: materialization.materializationId, pluginId: materialization.pluginId },
    } as const;
    const entryBase64 = encodeBase64(entryBytes);
    const chunkBase64 = encodeBase64(chunkBytes);
    const daemonResponse = {
        ok: true as const, artifactFamily: 'reactNative' as const, artifactOwnerKind: 'renderer' as const,
        cacheIdentity, crashStateToken,
        artifact: {
            pluginId: cacheIdentity.pluginId, contributionId: cacheIdentity.contributionId,
            artifactKind: 'reactNativeBundle' as const, digest: artifactDigest, format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        bytesBase64: entryBase64,
        files: [
            { ...files[0], bytesBase64: entryBase64 },
            { ...files[1], bytesBase64: chunkBase64 },
        ],
    };
    const wireBytes = JSON.stringify(daemonResponse).length;
    return { reader, cacheIdentity, crashStateToken, graph, origin, daemonResponse, entryBytes, chunkBytes, entryPath, chunkPath, wireBytes, entryBase64, chunkBase64 };
}

describe('U6 cold-mount integrity probe', () => {
    it('counts full-bytes hash passes on a cold daemon-sourced mount', async () => {
        activeAccountHostedArtifactSource.create.mockReturnValue(inactiveAccountHostedSource);
        const current = fixture();
        // eslint-disable-next-line no-console
        console.log(`\n=== wire payload: ${(current.wireBytes / 1048576).toFixed(2)}MiB for ${((ENTRY_BYTES_SIZE + CHUNK_BYTES_SIZE) / 1048576).toFixed(2)}MiB of artifact`);
        // eslint-disable-next-line no-console
        console.log(`=== entry base64 appears at top level (${(current.entryBase64.length / 1048576).toFixed(2)}MiB) AND inside files[] (${(current.entryBase64.length / 1048576).toFixed(2)}MiB)`);

        const persistent = createPersistentStore();
        const cache = createPluginReactNativeBundleCache({ persistentStore: undefined });
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });
        void persistent;

        probe.reset();
        const t0 = performance.now();
        const acquired = await producer.acquire({
            reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime, artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
            daemon: { origin: current.origin, serverId: scope.serverId },
            isCurrent: () => true,
        });
        const wall = performance.now() - t0;
        expect(acquired.kind).toBe('available');
        const total = probe.report(`COLD daemon mount (no persistent store) wall=${wall.toFixed(1)}ms`);
        expect(total.n).toBeGreaterThan(0);
    }, 120_000);

    it('counts full-bytes hash passes on a cold daemon-sourced mount WITH persistent custody', async () => {
        activeAccountHostedArtifactSource.create.mockReturnValue(inactiveAccountHostedSource);
        const current = fixture();
        const persistent = createPersistentStore();
        const cache = createPluginReactNativeBundleCache({ persistentStore: {
            read: async (identity) => {
                const record = await persistent.store.read(identity);
                return record ? { ...record, persistentIdentity: identity } as never : null;
            },
            write: async (record) => { await persistent.store.write(record); },
            remove: async (identity) => { await persistent.store.remove(identity); },
            removeAccount: async () => undefined,
        } });
        const producer = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
        });

        probe.reset();
        const t0 = performance.now();
        const acquired = await producer.acquire({
            reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime, artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
            daemon: { origin: current.origin, serverId: scope.serverId },
            isCurrent: () => true,
        });
        const wall = performance.now() - t0;
        expect(acquired.kind).toBe('available');
        probe.report(`COLD daemon mount + persistent write wall=${wall.toFixed(1)}ms`);

        // Second cold mount on a fresh cache reading the SAME persistent record.
        const cache2 = createPluginReactNativeBundleCache({ persistentStore: {
            read: async (identity) => {
                const record = await persistent.store.read(identity);
                return record ? { ...record, persistentIdentity: identity } as never : null;
            },
            write: async (record) => { await persistent.store.write(record); },
            remove: async (identity) => { await persistent.store.remove(identity); },
            removeAccount: async () => undefined,
        } });
        const producer2 = createPluginReactNativeArtifactAvailabilityProducer({
            getCache: () => cache2,
            appExact: inactiveAppExactSource,
            fetchDaemonArtifactBytes: async () => { throw new Error('daemon must not be contacted'); },
        });
        probe.reset();
        const t1 = performance.now();
        const acquired2 = await producer2.acquire({
            reader: current.reader, artifactGraph: current.graph, cacheIdentity: current.cacheIdentity,
            accountLifetime: permanentlyCurrentLifetime, artifactOwnerKind: 'renderer',
            crashStateToken: current.crashStateToken,
            daemon: { origin: current.origin, serverId: scope.serverId },
            isCurrent: () => true,
        });
        const wall2 = performance.now() - t1;
        expect(acquired2.kind).toBe('available');
        probe.report(`COLD mount from PERSISTENT cache wall=${wall2.toFixed(1)}ms`);
    }, 120_000);
});
