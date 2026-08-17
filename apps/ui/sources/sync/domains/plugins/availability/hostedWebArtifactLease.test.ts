import { describe, expect, it, vi } from 'vitest';

import type { DaemonPluginUiArtifactBytesReadResponse } from '@happier-dev/protocol';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
    type PluginAccountAvailabilityIntentReadResponseV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import type {
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import { acquirePluginHostedWebArtifactLease } from './hostedWebArtifactLease';

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
const slot = Object.freeze({
    pluginId: 'com.acme.hosted',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});

function fixture(input: Readonly<{
    materialized?: boolean;
}> = {}) {
    const entryPath = 'hosted-web/acme/index.html';
    const scriptPath = 'hosted-web/acme/assets/app.js';
    const entryBytes = new TextEncoder().encode('<!doctype html><script src="assets/app.js"></script>');
    const scriptBytes = new TextEncoder().encode('export const mounted = true;');
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
    ] as const;
    const digest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
        { relativePath: scriptPath, bytes: scriptBytes },
    ]);
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
    const response: PluginAccountAvailabilityIntentReadResponseV1 = {
        availabilityCursor: 1,
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
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: digest,
                compatibility: { hostUiApiVersion: '1.0.0' },
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        }),
        uiArtifacts: [{
            release: { pluginId: slot.pluginId, version: '1.2.3' },
            contributionId: slot.contributionId,
            tier: slot.tier,
            platform: slot.platform,
            artifactId: '00000000-0000-4000-8000-000000000001',
            artifactDigest: digest,
            compatibility: {
                hostAppVersion: '1.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                platform: 'web',
                channel: 'store',
                nativeCapabilities: [],
            },
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
            tier: slot.tier,
            platform: slot.platform,
            artifactDigest: digest,
        }],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    const cacheIdentity = Object.freeze({
        pluginId: slot.pluginId,
        // The projected hosted renderer identity can differ from the generated
        // Account Artifact slot that the signed graph names.
        contributionId: 'hosted-renderer',
        artifactDigest: digest,
        platform: 'web' as const,
        projectionGeneration: 1,
    });
    return Object.freeze({
        graph: {
            contributionId: slot.contributionId,
            tier: slot.tier,
            platform: slot.platform,
            entry: entryPath,
            files,
            digest,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {},
        },
        cacheIdentity,
        snapshot: Object.freeze({
            availabilityCursor: 1,
            intentReads: [{ pluginId: slot.pluginId, response }],
            materializations: input.materialized ? [materialization] : [],
        } satisfies PluginAccountAvailabilitySnapshot),
        bytesByPath: new Map<string, Uint8Array>([
            [entryPath, entryBytes],
            [scriptPath, scriptBytes],
        ]),
        record: Object.freeze({
            persistentIdentity: Object.freeze({
                accountScope: scope,
                releaseVersion: '1.2.3',
                pluginId: slot.pluginId,
                contributionId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: digest,
            }),
            bytes: entryBytes,
            entryRelativePath: entryPath,
            files: Object.freeze(files.map((file) => Object.freeze({
                ...file,
                bytes: new Uint8Array(
                    file.relativePath === entryPath ? entryBytes : scriptBytes,
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
            cacheIdentity,
            artifact: Object.freeze({
                pluginId: cacheIdentity.pluginId,
                contributionId: cacheIdentity.contributionId,
                artifactKind: 'hostedWebAsset' as const,
                digest,
                byteSize: entryBytes.byteLength,
            }),
            bytesBase64: encodeBase64(entryBytes),
            files: files.map((file) => ({
                ...file,
                bytesBase64: encodeBase64(file.relativePath === entryPath ? entryBytes : scriptBytes),
            })),
        } satisfies DaemonPluginUiArtifactBytesReadResponse,
    });
}

function persistentRecordKey(identity: PluginUiPersistentArtifactRecord['persistentIdentity']): string {
    return [
        identity.accountScope.serverId,
        identity.accountScope.accountId,
        identity.releaseVersion,
        identity.pluginId,
        identity.contributionId,
        identity.tier,
        identity.platform,
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
    });
}

function createReader(snapshot: PluginAccountAvailabilitySnapshot) {
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope, snapshot });
    return store.bind(scope);
}

describe('hosted-web Artifact lease acquisition', () => {
    it('uses the exact daemon family for the generated Account slot while retaining the renderer read identity', async () => {
        const current = fixture({ materialized: true });
        const fetchArtifactBytes = vi.fn(async () => current.daemonResponse);
        const reader = createReader(current.snapshot);

        expect(reader.classifyRelease(current.snapshot.materializations[0]!)).toMatchObject({
            releaseContent: 'matched',
            validation: { kind: 'admitted' },
        });

        const acquired = await acquirePluginHostedWebArtifactLease({
            reader,
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
                artifact: {
                    contributionId: slot.contributionId,
                    digest: current.graph.digest,
                },
            },
        });
        expect(fetchArtifactBytes).toHaveBeenCalledWith({
            origin: current.origin,
            serverId: scope.serverId,
            identity: current.cacheIdentity,
        });
    });

    it('does not accept a React Native artifact response as hosted-web bytes', async () => {
        const current = fixture({ materialized: true });
        const wrongFamily: DaemonPluginUiArtifactBytesReadResponse = {
            ok: true,
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'voiceProvider',
            cacheIdentity: {
                pluginId: current.cacheIdentity.pluginId,
                contributionId: 'native-renderer',
                artifactDigest: current.cacheIdentity.artifactDigest,
                hostAppVersion: '1.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
                platform: 'ios',
                channel: 'internal',
                nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
                projectionGeneration: current.cacheIdentity.projectionGeneration,
            },
            artifact: {
                pluginId: current.cacheIdentity.pluginId,
                contributionId: 'native-renderer',
                artifactKind: 'reactNativeBundle',
                digest: current.cacheIdentity.artifactDigest,
                format: 'plainJs',
                byteSize: 1,
            },
            bytesBase64: 'YQ==',
            files: [{
                relativePath: 'native.js',
                digest: computePluginUiArtifactSha256DigestV1(new TextEncoder().encode('a')),
                byteSize: 1,
                bytesBase64: 'YQ==',
            }],
        };
        const fetchArtifactBytes = vi.fn(async () => wrongFamily);

        await expect(acquirePluginHostedWebArtifactLease({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            daemon: {
                origin: current.origin,
                serverId: scope.serverId,
                fetchArtifactBytes,
            },
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_source_unavailable' });
        expect(fetchArtifactBytes).toHaveBeenCalledOnce();
    });

    it('uses the current Account-scoped persistent Artifact before app and Account-hosted candidates', async () => {
        const current = fixture();
        const persistent = createPersistentStore(current.record);
        const appExact = vi.fn(async ({ relativePath }: { relativePath: string }) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        const accountHosted = vi.fn(async ({ relativePath }: { relativePath: string }) => (
            current.bytesByPath.get(relativePath) ?? null
        ));

        const acquired = await acquirePluginHostedWebArtifactLease({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: persistentScope(persistent),
            appExact: { kind: 'appExact', readFile: appExact },
            accountHosted: { kind: 'accountHosted', readFile: accountHosted },
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
        const accountHosted = vi.fn(async ({ relativePath }: { relativePath: string }) => (
            current.bytesByPath.get(relativePath) ?? null
        ));

        const acquired = await acquirePluginHostedWebArtifactLease({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            persistent: persistentScope(persistent),
            appExact: { kind: 'appExact', readFile: appExact },
            accountHosted: { kind: 'accountHosted', readFile: accountHosted },
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { sourceKind: 'accountHosted' },
        });
        expect(persistent.read).toHaveBeenCalledOnce();
        expect(appExact).toHaveBeenCalledOnce();
        expect(accountHosted).toHaveBeenCalledTimes(2);
    });

    it('permanently discards only the exact persistent Artifact when Availability withdraws it', async () => {
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
        const acquired = await acquirePluginHostedWebArtifactLease({
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
        expect(persistent.remove).toHaveBeenCalledTimes(1);
        expect(persistent.remove).toHaveBeenCalledWith(current.record.persistentIdentity);
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.records.has(persistentRecordKey(current.record.persistentIdentity))).toBe(false);
        expect(persistent.records.has(persistentRecordKey(neighboringRecord.persistentIdentity))).toBe(true);
    });

    it('permanently discards the old exact persistent Artifact when Availability replaces its version', async () => {
        const current = fixture();
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const persistent = createPersistentStore(current.record);
        const acquired = await acquirePluginHostedWebArtifactLease({
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
        expect(persistent.remove).toHaveBeenCalledTimes(1);
        expect(persistent.remove).toHaveBeenCalledWith(current.record.persistentIdentity);
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.records.has(persistentRecordKey(current.record.persistentIdentity))).toBe(false);
    });
});
