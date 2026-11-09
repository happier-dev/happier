import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonPluginUiArtifactBytesReadResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    deriveGeneratedHostedWebAssetPolicyV1,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
    type PluginAccountAvailabilityIntentReadResponseV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import {
    adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache,
    createPluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import type {
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import {
    acquirePluginHostedWebArtifactLease,
    createPluginHostedWebBrowserArtifactAvailabilityProducer,
    projectSelectedHostedWebBrowserArtifactAvailability,
    type PluginHostedWebArtifactLeaseInput,
} from './hostedWebArtifactLease';

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
const slot = Object.freeze({
    pluginId: 'com.acme.hosted',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});
const createLifetime = () => Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});
let accountLifetime = createLifetime();
beforeEach(() => { accountLifetime = createLifetime(); });

function acquire(input: Omit<PluginHostedWebArtifactLeaseInput, 'accountLifetime'>) {
    return acquirePluginHostedWebArtifactLease({ ...input, accountLifetime });
}

it('bootstraps an Account hosted-web lease from advertised bytes without an explicit Machine target', async () => {
    const current = fixture({ materialized: true });
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope, snapshot: { ...current.snapshot, intentReads: current.snapshot.intentReads.map(row => ({
        ...row, response: { ...row.response, uiArtifacts: [] },
    })) } });
    const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);
    const result = await acquire({ reader: store.bind(scope), artifactGraph: current.graph,
        cacheIdentity: current.cacheIdentity, fetchDaemonArtifactBytes: fetchArtifactBytes });
    try {
        expect(result).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        expect(fetchArtifactBytes).toHaveBeenCalledWith(expect.objectContaining({
            transport: { serverId: scope.serverId, machineId: current.origin.materializationRef.machineId },
            family: 'hostedWeb', digest: current.graph.digest,
        }));
        if (result.kind === 'available') {
            expect(await result.lease.readFile(current.graph.entry)).toMatchObject({ kind: 'available' });
        }
    } finally { if (result.kind === 'available') result.lease.dispose(); }
});

it('admits the exact portable Machine installation without an Account selection or hosting', async () => {
    const current = fixture({ materialized: true });
    const response = current.snapshot.intentReads[0]!.response;
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope, snapshot: { ...current.snapshot,
        releases: [response.release!],
        intentReads: [{ pluginId: slot.pluginId, response: {
            ...response, intent: null, release: null, uiArtifacts: [], hostingCapability: { enabled: false },
        } }],
    } });
    const fetchDaemonArtifactBytes = vi.fn(async () => current.daemonResponse);
    const request = { reader: store.bind(scope), artifactGraph: current.graph,
        cacheIdentity: current.cacheIdentity, executionOrigin: current.origin,
        fetchDaemonArtifactBytes };
    for (const executionOrigin of [undefined, { ...current.origin,
        materializationRef: { ...current.origin.materializationRef, materializationId: 'another-installation' } }]) {
        expect(await acquire({ ...request, executionOrigin })).toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    expect(fetchDaemonArtifactBytes).not.toHaveBeenCalled();
    const result = await acquire(request);
    try {
        expect(result).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
    } finally { if (result.kind === 'available') result.lease.dispose(); }
});

function fixture(input: Readonly<{
    materialized?: boolean;
    extraFiles?: Readonly<Record<string, string>>;
}> = {}) {
    const entryPath = 'hosted-web/hosted-artifact/index.html';
    const scriptPath = 'hosted-web/hosted-artifact/assets/app.js';
    const entryBytes = new TextEncoder().encode('<!doctype html><script src="assets/app.js"></script>');
    const scriptBytes = new TextEncoder().encode('export const mounted = true;');
    const bytesByPath = new Map<string, Uint8Array>([
        [entryPath, entryBytes],
        [scriptPath, scriptBytes],
        ...Object.entries(input.extraFiles ?? {}).map(([path, text]) => (
            [`hosted-web/hosted-artifact/${path}`, new TextEncoder().encode(text)] as const
        )),
    ]);
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
        {
            relativePath: scriptPath,
            digest: computePluginUiArtifactSha256DigestV1(scriptBytes),
            byteSize: scriptBytes.byteLength,
        },
        ...[...bytesByPath].slice(2).map(([relativePath, bytes]) => ({
            relativePath,
            digest: computePluginUiArtifactSha256DigestV1(bytes),
            byteSize: bytes.byteLength,
        })),
    ] as const;
    const digest = computePluginUiArtifactFileSetSha256DigestV1(
        [...bytesByPath].map(([relativePath, bytes]) => ({ relativePath, bytes })),
    );
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
    const response: PluginAccountAvailabilityIntentReadResponseV1 = {
        availabilityCursor: 1,
        packageAssets: [],
        hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: {
            pluginId: slot.pluginId,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'enabled',
            writableCollections: [],
            revision: 'intent-1',
        },
        release: PluginReleaseFactsV1Schema.parse({
            ref: { pluginId: slot.pluginId, version: '1.2.3' },
            archiveDigestSha256,
            normalizedManifest: {
                schemaVersion: 2,
                id: slot.pluginId,
                version: '1.2.3',
                displayName: 'Hosted fixture',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                contributes: {},
            },
            collectionContracts: [],
            uiSlots: [{
                contributionId: slot.contributionId,
                artifactId: 'hosted-artifact',
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: digest,
                hostUiApiRange: '^1.0.0',
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        }),
        uiArtifacts: [{
            release: { pluginId: slot.pluginId, version: '1.2.3' },
            contributionId: slot.contributionId,
            artifactId: 'hosted-artifact',
            tier: slot.tier,
            platform: slot.platform,
            accountArtifactId: '00000000-0000-4000-8000-000000000001',
            artifactDigest: digest,
            hostUiApiRange: '^1.0.0',
        }],
    };
    const materialization: PluginMachineMaterializationV1 = {
        serverIdentityId: 'srv_account_one',
        machineId: 'machine-a',
        materializationId: 'install-a',
        pluginId: slot.pluginId,
        version: '1.2.3',
        sourceClass: 'versionedArchive',
        portableRelease: true,
        archiveDigestSha256,
        uiArtifacts: [{
            contributionId: slot.contributionId,
            artifactId: 'hosted-artifact',
            tier: slot.tier,
            platform: slot.platform,
            artifactDigest: digest,
            hostUiApiRange: '^1.0.0',
        }],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    const cacheIdentity = Object.freeze({
        pluginId: slot.pluginId,
        contributionId: slot.contributionId,
        artifactId: 'hosted-artifact',
        artifactDigest: digest,
        platform: 'web' as const,
    });
    return Object.freeze({
        graph: {
            artifactId: 'hosted-artifact',
            tier: slot.tier,
            entry: entryPath,
            files,
            digest,
            builtWith: { staging: 'staticDirectory' as const },
            hostUiApiRange: '^1.0.0',
        },
        cacheIdentity,
        snapshot: Object.freeze({
            availabilityCursor: 1,
            intentReads: [{ pluginId: slot.pluginId, response }],
            materializations: input.materialized ? [materialization] : [],
            snapshots: [{
                serverIdentityId: materialization.serverIdentityId,
                machineId: materialization.machineId,
                materializations: input.materialized ? [materialization] : [],
            }],
        } satisfies PluginAccountAvailabilitySnapshot),
        bytesByPath,
        record: Object.freeze({
            persistentIdentity: Object.freeze({
                accountScope: scope,
                artifactDigest: digest,
            }),
            bytes: entryBytes,
            entryRelativePath: entryPath,
            files: Object.freeze(files.map((file) => Object.freeze({
                ...file,
                bytes: new Uint8Array(
                    bytesByPath.get(file.relativePath)!,
                ),
            }))),
        } satisfies PluginUiPersistentArtifactRecord),
        origin: Object.freeze({
            serverIdentityId: materialization.serverIdentityId,
            materializationRef: Object.freeze({
                machineId: materialization.machineId,
                materializationId: materialization.materializationId,
                pluginId: materialization.pluginId,
            }),
        }),
        daemonResponse: {
            ok: true as const,
            artifactFamily: 'hostedWeb' as const,
            cacheIdentity: { artifactDigest: digest },
            artifact: Object.freeze({
                artifactKind: 'hostedWebAsset' as const,
                digest,
                byteSize: entryBytes.byteLength,
            }),
            files: files.map((file) => ({
                ...file,
                bytesBase64: encodeBase64(bytesByPath.get(file.relativePath)!),
            })),
        } satisfies DaemonPluginUiArtifactBytesReadResponse,
    });
}

function persistentRecordKey(identity: PluginUiPersistentArtifactRecord['persistentIdentity']): string {
    return [
        identity.accountScope.serverId,
        identity.accountScope.accountId,
        identity.artifactDigest,
    ].join('\u0000');
}

function createPersistentStore(...initialRecords: readonly PluginUiPersistentArtifactRecord[]) {
    const records = new Map(initialRecords.map((record) => [
        persistentRecordKey(record.persistentIdentity),
        record,
    ]));
    const read = vi.fn(async (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => (
        records.get(persistentRecordKey(identity)) ?? null
    ));
    const write = vi.fn(async (record: PluginUiPersistentArtifactRecord) => {
        records.set(persistentRecordKey(record.persistentIdentity), record);
        return 'persisted' as const;
    });
    const remove = vi.fn(async (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => {
        records.delete(persistentRecordKey(identity));
    });
    const removeAccount = vi.fn(async (accountScope: ServerAccountScope) => {
        for (const [key, record] of records.entries()) {
            if (
                record.persistentIdentity.accountScope.serverId === accountScope.serverId
                && record.persistentIdentity.accountScope.accountId === accountScope.accountId
            ) {
                records.delete(key);
            }
        }
    });
    const store: PluginUiPersistentArtifactStore = Object.freeze({
        read,
        write,
        remove,
        removeAccount,
    });
    return Object.freeze({ records, read, write, remove, removeAccount, store });
}

function persistentScope(persistent: ReturnType<typeof createPersistentStore>) {
    return Object.freeze({
        scope,
        store: persistent.store,
        isCurrent: () => true,
        removePersistentArtifact: persistent.remove,
    });
}

function snapshotWithAvailability(input: Readonly<{
    current: ReturnType<typeof fixture>;
    availabilityCursor: number;
    enabled?: boolean;
    version?: string;
}>): PluginAccountAvailabilitySnapshot {
    const response = input.current.snapshot.intentReads[0]?.response;
    if (!response?.intent || !response.release) throw new Error('Fixture must contain an enabled release intent.');
    const version = input.version ?? response.intent.desiredVersion;
    const release = version === response.release.ref.version
        ? response.release
        : PluginReleaseFactsV1Schema.parse({
            ...response.release,
            ref: { ...response.release.ref, version },
            normalizedManifest: { ...response.release.normalizedManifest, version },
        });
    return Object.freeze({
        availabilityCursor: input.availabilityCursor,
        intentReads: Object.freeze([Object.freeze({
            pluginId: slot.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                ...response,
                availabilityCursor: input.availabilityCursor,
                intent: {
                    ...response.intent,
                    desiredVersion: version,
                    enabled: input.enabled ?? response.intent.enabled,
                    revision: `intent-${input.availabilityCursor}`,
                },
                release,
                uiArtifacts: response.uiArtifacts.map((artifact) => ({
                    ...artifact,
                    release: { ...artifact.release, version },
                })),
            }),
        })]),
        materializations: input.current.snapshot.materializations,
        snapshots: input.current.snapshot.snapshots,
    });
}

function createReader(snapshot: PluginAccountAvailabilitySnapshot) {
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope, snapshot });
    return store.bind(scope);
}

describe('verified hosted-web browser projection', () => {
    it('acquires through the real Account cache operation without native resource registration', async () => {
        const current = fixture();
        const persistent = createPersistentStore(current.record);
        const cache = createPluginReactNativeBundleCache({
            persistentStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(persistent.store),
        });
        const producer = createPluginHostedWebBrowserArtifactAvailabilityProducer({ getCache: () => cache });
        const policy = deriveGeneratedHostedWebAssetPolicyV1(current.graph);
        if (!policy) throw new Error('Expected a generated hosted-web policy');
        const result = await producer.acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime,
            isCurrent: () => true,
            hostedWebPolicy: { ...policy, requestPath: '/' },
        });
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error('Expected cache-backed browser availability');
        expect(result.handle.bundle.entrypoint).toBe('index.html');
        expect(persistent.read).toHaveBeenCalledTimes(1);
        result.handle.dispose();
        expect(result.handle.isCurrent()).toBe(false);
    });

    it('projects the complete policy-qualified file graph without a native store or Machine target and revokes with its lease', async () => {
        const current = fixture({ extraFiles: {
            'assets/theme.css': 'body { color: red; }',
            'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'assets/app.js.map': '{"version":3}',
            'assets/private.bin': 'not a browser asset',
            'assets/pound#name.json': '{"name":"hash"}',
            'assets/percent%name.json': '{"name":"percent"}',
            'constructor/prototype/__proto__/module.js': 'export const portable = true;',
            '%2e%2e/encoded.json': '{"name":"literal encoded dots"}',
        } });
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountHosted: { kind: 'accountHosted', fetch: async () => current.bytesByPath },
        });
        expect(acquired.kind).toBe('available');
        if (acquired.kind !== 'available') throw new Error('Expected the verified Account-hosted lease');

        const result = await projectSelectedHostedWebBrowserArtifactAvailability({
            lease: acquired.lease,
            isCurrent: () => true,
        });
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error('Expected a browser projection');
        try {
            expect(result.handle.bundle).toEqual({
                v: 1,
                entrypoint: 'index.html',
                files: {
                    'index.html': { mime: 'text/html', contentBase64: encodeBase64(current.record.bytes) },
                    'assets/app.js': { mime: 'text/javascript', contentBase64: encodeBase64(current.bytesByPath.get('hosted-web/hosted-artifact/assets/app.js')!) },
                    'assets/theme.css': { mime: 'text/css', contentBase64: encodeBase64(current.bytesByPath.get('hosted-web/hosted-artifact/assets/theme.css')!) },
                    'assets/icon.svg': { mime: 'image/svg+xml', contentBase64: encodeBase64(current.bytesByPath.get('hosted-web/hosted-artifact/assets/icon.svg')!) },
                    'assets/pound#name.json': { mime: 'application/json', contentBase64: encodeBase64(current.bytesByPath.get('hosted-web/hosted-artifact/assets/pound#name.json')!) },
                    'assets/percent%name.json': { mime: 'application/json', contentBase64: encodeBase64(current.bytesByPath.get('hosted-web/hosted-artifact/assets/percent%name.json')!) },
                    'constructor/prototype/__proto__/module.js': { mime: 'text/javascript', contentBase64: encodeBase64(current.bytesByPath.get('hosted-web/hosted-artifact/constructor/prototype/__proto__/module.js')!) },
                    '%2e%2e/encoded.json': { mime: 'application/json', contentBase64: encodeBase64(current.bytesByPath.get('hosted-web/hosted-artifact/%2e%2e/encoded.json')!) },
                },
            });
            const revoked = vi.fn();
            const subscription = result.handle.onRevoke(revoked);
            readerStore.replace({ scope, snapshot: snapshotWithAvailability({ current, availabilityCursor: 2, enabled: false }) });
            expect(result.handle.isCurrent()).toBe(false);
            expect(revoked).toHaveBeenCalledTimes(1);
            subscription.dispose();
        } finally {
            result.handle.dispose();
        }
        expect(acquired.lease.isCurrent()).toBe(false);
    });

    it('refuses a retired lease before exposing executable bytes', async () => {
        const current = fixture();
        const acquired = await acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountHosted: { kind: 'accountHosted', fetch: async () => current.bytesByPath },
        });
        if (acquired.kind !== 'available') throw new Error('Expected a verified lease');
        acquired.lease.dispose();
        await expect(projectSelectedHostedWebBrowserArtifactAvailability({
            lease: acquired.lease,
            isCurrent: () => true,
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    });
});

describe('hosted-web Artifact lease acquisition', () => {
    it.each([
        'artifact_bytes_rpc_unavailable',
        'artifact_bytes_response_invalid',
        'artifact_bytes_fetch_failed',
        'plugin_host_access_disclosure_mismatch',
    ] as const)('preserves the safe daemon refusal %s through the real source and lease', async (code) => {
        const current = fixture({ materialized: true });
        const acquired = await acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: 'machine-a', serverId: scope.serverId },
            // The byte fetcher is the machine transport boundary; decoding,
            // selection, fallback and Artifact verification remain real.
            fetchDaemonArtifactBytes: async () => ({
                ok: false, code: 'artifact_unavailable', diagnostics: [code, 'private detail must not propagate'],
            }),
        });
        expect(acquired).toEqual({ kind: 'unavailable', code });
    });

    it('tries Account-hosted bytes after a daemon refusal instead of turning a source failure into admission', async () => {
        const current = fixture({ materialized: true });
        const acquired = await acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: 'machine-a', serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => ({
                ok: false, code: 'artifact_unavailable', diagnostics: ['artifact_bytes_fetch_failed'],
            }),
            accountHosted: { kind: 'accountHosted', fetch: async () => current.bytesByPath },
        });
        expect(acquired.kind).toBe('available');
        if (acquired.kind !== 'available') throw new Error('Expected fallback bytes');
        expect(acquired.lease.sourceKind).toBe('accountHosted');
        acquired.lease.dispose();
    });

    it('uses a current daemon projection to select exact app bytes without an Account release', async () => {
        const current = fixture();
        const appRead = vi.fn(async () => current.bytesByPath);

        const acquired = await acquire({
            reader: createReader(Object.freeze({
                ...current.snapshot,
                intentReads: Object.freeze([]),
                materializations: Object.freeze([]),
                snapshots: Object.freeze([]),
            })),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            appExact: Object.freeze({ kind: 'appExact' as const, fetch: appRead }),
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: async () => current.daemonResponse,
            daemonProjectionSelection: Object.freeze({
                occurrenceId: 'com.acme.hosted-occurrence-a',
                contributionId: slot.contributionId,
                releaseVersion: '1.2.3',
                isCurrent: () => true,
            }),
        });

        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'appExact' } });
        expect(appRead).toHaveBeenCalledTimes(1);
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('fetches selected originless daemon bytes when the app does not contain that digest', async () => {
        const current = fixture();
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        const acquired = await acquire({
            reader: createReader(Object.freeze({
                ...current.snapshot,
                intentReads: Object.freeze([]),
                materializations: Object.freeze([]),
                snapshots: Object.freeze([]),
            })),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            appExact: Object.freeze({ kind: 'appExact' as const, fetch: async () => null }),
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
            daemonProjectionSelection: Object.freeze({
                occurrenceId: 'com.acme.hosted-occurrence-a',
                contributionId: slot.contributionId,
                releaseVersion: '1.2.3',
                isCurrent: () => true,
            }),
        });

        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            transport: {
                machineId: current.origin.materializationRef.machineId,
                serverId: scope.serverId,
            },
            family: 'hostedWeb',
            digest: current.cacheIdentity.artifactDigest,
            signal: expect.any(AbortSignal),
        });
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('uses the exact daemon family for the generated Account slot while retaining the renderer read identity', async () => {
        const current = fixture({ materialized: true });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);
        const reader = createReader(current.snapshot);

        expect(reader.classifyRelease(current.snapshot.materializations[0]!)).toMatchObject({
            releaseContent: 'matched',
            validation: { kind: 'admitted' },
        });

        const acquired = await acquire({
            reader,
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
                    contributionId: slot.contributionId,
                    digest: current.graph.digest,
                },
            },
        });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            transport: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            family: 'hostedWeb',
            digest: current.cacheIdentity.artifactDigest,
            signal: expect.any(AbortSignal),
        });
    });

    it('rejects a cache identity for a different generated artifact before fetching bytes', async () => {
        const current = fixture({ materialized: true });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);

        await expect(acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: {
                ...current.cacheIdentity,
                artifactId: 'different-hosted-artifact',
            },
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
        expect(fetchArtifactBytes).not.toHaveBeenCalled();
    });

    it('keeps an acquired daemon-sourced lease current after its daemon materialization disappears', async () => {
        const current = fixture({ materialized: true });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const reader = store.bind(scope);

        const acquired = await acquire({
            reader,
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        });
        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        if (acquired.kind !== 'available') throw new Error('unreachable');

        // The daemon that supplied the bytes goes away. The bytes are already
        // copied, integrity-verified and in host custody, and the Account's
        // current Artifact admission is unchanged, so the lease must survive.
        store.replace({
            scope,
            snapshot: Object.freeze({
                ...current.snapshot,
                materializations: Object.freeze([]),
            }),
        });

        expect(acquired.lease.isCurrent()).toBe(true);
        await expect(acquired.lease.readFile(current.graph.entry)).resolves.toMatchObject({
            kind: 'available',
        });
    });

    it('does not accept a React Native artifact response as hosted-web bytes', async () => {
        const current = fixture({ materialized: true });
        const wrongFamily: DaemonPluginUiArtifactBytesReadResponse = {
            ok: true,
            artifactFamily: 'reactNative',
            cacheIdentity: {
                artifactDigest: current.cacheIdentity.artifactDigest,
            },
            artifact: {
                artifactKind: 'reactNativeBundle',
                digest: current.cacheIdentity.artifactDigest,
                format: 'plainJs',
                byteSize: 1,
            },
            files: [{
                relativePath: 'native.js',
                digest: computePluginUiArtifactSha256DigestV1(new TextEncoder().encode('a')),
                byteSize: 1,
                bytesBase64: 'YQ==',
            }],
        };
        const fetchArtifactBytes = vi.fn(async () => wrongFamily);

        await expect(acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
            fetchDaemonArtifactBytes: fetchArtifactBytes,
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_source_unavailable' });
        expect(fetchArtifactBytes).toHaveBeenCalledOnce();
    });

    it('uses the current Account-scoped persistent Artifact before app and Account-hosted candidates', async () => {
        const current = fixture();
        const persistent = createPersistentStore(current.record);
        const appExact = vi.fn(async () => current.bytesByPath);
        const accountHosted = vi.fn(async () => current.bytesByPath);

        const acquired = await acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: persistentScope(persistent),
            appExact: { kind: 'appExact', fetch: appExact },
            accountHosted: { kind: 'accountHosted', fetch: accountHosted },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: {
                sourceKind: 'persistentCache',
                artifact: expect.objectContaining({ digest: current.graph.digest }),
            },
        });
        expect(persistent.read).toHaveBeenCalledOnce();
        expect(appExact).not.toHaveBeenCalled();
        expect(accountHosted).not.toHaveBeenCalled();
    });

    it('uses Account-hosted bytes only after the current cache and exact app candidate miss', async () => {
        const current = fixture();
        const persistent = createPersistentStore();
        const appExact = vi.fn(async () => null);
        const accountHosted = vi.fn(async () => current.bytesByPath);

        const acquired = await acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: persistentScope(persistent),
            appExact: { kind: 'appExact', fetch: appExact },
            accountHosted: { kind: 'accountHosted', fetch: accountHosted },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'accountHosted' },
        });
        expect(persistent.read).toHaveBeenCalledOnce();
        expect(appExact).toHaveBeenCalledOnce();
        expect(accountHosted).toHaveBeenCalledTimes(1);
    });

    it('retires the lease without deleting the retained bytes when the Account disables the plugin', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const neighboringRecord: PluginUiPersistentArtifactRecord = Object.freeze({
            ...current.record,
            persistentIdentity: Object.freeze({
                ...current.record.persistentIdentity,
                artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'e'.repeat(64)}`),
            }),
        });
        const persistent = createPersistentStore(current.record, neighboringRecord);
        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: persistentScope(persistent),
        });
        if (acquired.kind !== 'available') throw new Error('Fixture lease was unavailable.');

        readerStore.replace({
            scope,
            snapshot: snapshotWithAvailability({
                current,
                availabilityCursor: 2,
                enabled: false,
            }),
        });
        await Promise.resolve();

        expect(acquired.lease.isCurrent()).toBe(false);
        // Disable stops new use and retains the bounded archive (PEP-ARTIFACTS
        // 10.1); the projection writer that holds both verified snapshots is the
        // only owner allowed to delete these bytes.
        expect(persistent.remove).not.toHaveBeenCalled();
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.records.has(persistentRecordKey(current.record.persistentIdentity))).toBe(true);
        expect(persistent.records.has(persistentRecordKey(neighboringRecord.persistentIdentity))).toBe(true);
    });

    it('retires the lease on a version replacement and leaves the superseded deletion to the projection writer', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const persistent = createPersistentStore(current.record);
        const acquired = await acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: persistentScope(persistent),
        });
        if (acquired.kind !== 'available') throw new Error('Fixture lease was unavailable.');

        readerStore.replace({
            scope,
            snapshot: snapshotWithAvailability({
                current,
                availabilityCursor: 2,
                version: '1.2.4',
            }),
        });
        await Promise.resolve();

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(persistent.remove).not.toHaveBeenCalled();
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.records.has(persistentRecordKey(current.record.persistentIdentity))).toBe(true);
    });
});
