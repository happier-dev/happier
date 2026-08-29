import { describe, expect, it, vi } from 'vitest';

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';

import {
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import {
    acquirePluginSelectedArtifactLease,
    createPluginArtifactPersistentSource,
    persistVerifiedPluginArtifactLease,
} from './artifactLease';
import type { PluginArtifactLeasePersistentScope } from './artifactLease';
import type {
    PluginUiPersistentArtifactRecord,
} from '@/sync/domains/plugins/ui/artifactByteCache';

const scope = { serverId: 'srv-local-a', accountId: 'account-a' } as const;
const slot = {
    pluginId: 'com.acme.fixture',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
};

function fixture(
    current: boolean,
    availabilityCursor = 42,
    accountArtifactId: string | null = '00000000-0000-4000-8000-000000000001',
    /** Declares an artifact digest that is not the declared file set's digest. */
    artifactDigestOverride?: `sha256:${string}`,
) {
    const entryPath = 'hosted-web/acme/index.html';
    const appPath = 'hosted-web/acme/app.js';
    const entryBytes = new TextEncoder().encode('<!doctype html><script src="/app.js"></script>');
    const appBytes = new TextEncoder().encode('export const rendered = true;');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
        {
            relativePath: appPath,
            digest: computePluginUiArtifactSha256DigestV1(appBytes),
            byteSize: appBytes.byteLength,
        },
    ];
    const digest = artifactDigestOverride ?? computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
        { relativePath: appPath, bytes: appBytes },
    ]);
    const releaseCompatibility = {
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
    };
    const accountArtifactCompatibility = {
        hostAppVersion: '1.0.0',
        ...releaseCompatibility,
        platform: 'web' as const,
        channel: 'store' as const,
        nativeCapabilities: [],
    };
    const intentRead = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor,
        hostingCapability: {
            enabled: true,
            maxArtifactBytes: 1024,
            maxAccountBytes: 2048,
        },
        intent: {
            pluginId: slot.pluginId,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'enabled',
            writableCollections: [],
            revision: 'intent-1',
        },
        release: {
            ref: { pluginId: slot.pluginId, version: '1.2.3' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: slot.pluginId,
                version: '1.2.3',
                displayName: 'Fixture',
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
                compatibility: {
                    hostUiApiVersion: releaseCompatibility.hostUiApiVersion,
                },
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        },
        uiArtifacts: accountArtifactId ? [{
            release: { pluginId: slot.pluginId, version: '1.2.3' },
            contributionId: slot.contributionId,
            tier: slot.tier,
            platform: slot.platform,
            artifactId: accountArtifactId,
            artifactDigest: digest,
            compatibility: accountArtifactCompatibility,
        }] : [],
    });
    return {
        snapshot: {
            availabilityCursor,
            intentReads: current ? [{ pluginId: slot.pluginId, response: intentRead }] : [],
            materializations: [],
            snapshots: [],
        } satisfies PluginAccountAvailabilitySnapshot,
        artifact: {
            digest,
            releaseVersion: '1.2.3',
        },
        graph: {
            contributionId: slot.contributionId,
            tier: slot.tier,
            entry: entryPath,
            files,
            digest,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {},
        },
        bytesByPath: new Map([
            [entryPath, entryBytes],
            [appPath, appBytes],
        ]),
    };
}

/**
 * The real persistent byte custody seam: one retained verified record plus the
 * Artifact custody owner's exact-entry deletion. Tests assert against this adapter rather
 * than a hand-rolled source so a deletion decision cannot hide behind a fake.
 */
function persistentCustody(record: ReturnType<typeof fixture>) {
    const removePersistentArtifact = vi.fn(async () => {});
    const read = vi.fn(async (): Promise<PluginUiPersistentArtifactRecord | null> => Object.freeze({
        persistentIdentity: Object.freeze({
            accountScope: scope,
            releaseVersion: record.artifact.releaseVersion,
            pluginId: slot.pluginId,
            contributionId: slot.contributionId,
            tier: slot.tier,
            platform: slot.platform,
            artifactDigest: record.artifact.digest,
        }),
        bytes: record.bytesByPath.get(record.graph.entry)!,
        entryRelativePath: record.graph.entry,
        files: Object.freeze(record.graph.files.map((file) => Object.freeze({
            relativePath: file.relativePath,
            digest: file.digest,
            byteSize: file.byteSize,
            bytes: record.bytesByPath.get(file.relativePath)!,
        }))),
    }));
    const persistent: PluginArtifactLeasePersistentScope = Object.freeze({
        scope,
        store: Object.freeze({
            read,
            write: async () => {},
            remove: removePersistentArtifact,
            removeAccount: async () => {},
        }),
        isCurrent: () => true,
        removePersistentArtifact,
    });
    const source = createPluginArtifactPersistentSource({
        scope: persistent,
        identity: record.artifact.digest,
        artifactMatchesIdentity: (artifact, identity) => artifact.digest === identity,
    });
    return { persistent, source, read, removePersistentArtifact };
}

describe('Artifact selected handle lease', () => {
    it('does not let persistent bytes select themselves without a current Availability Artifact fact', async () => {
        const current = fixture(false);
        const persistentRead = vi.fn(async ({ relativePath }: { relativePath: string }) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{ kind: 'persistentCache', readFile: persistentRead }],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(persistentRead).not.toHaveBeenCalled();
    });

    it('materializes one verified exact Artifact source in source order and revokes it on Availability replacement', async () => {
        const initial = fixture(false);
        const current = fixture(true);
        const appRead = vi.fn(async ({ relativePath }: { relativePath: string }) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        const persistentRead = vi.fn(async ({ relativePath }: { relativePath: string }) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });

        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [
                { kind: 'persistentCache', readFile: persistentRead },
                { kind: 'appExact', readFile: appRead },
            ],
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: {
                artifact: expect.objectContaining(current.artifact),
            },
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
        expect(acquired.lease.artifact).not.toHaveProperty('accountArtifactId');
        expect(persistentRead).toHaveBeenCalledTimes(2);
        expect(appRead).not.toHaveBeenCalled();
        await expect(acquired.lease.readFile('hosted-web/acme/app.js')).resolves.toMatchObject({
            kind: 'available',
            bytes: current.bytesByPath.get('hosted-web/acme/app.js'),
        });

        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);
        store.replace({
            scope,
            snapshot: fixture(false).snapshot,
        });

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(revoked).toHaveBeenCalledTimes(1);
        await expect(acquired.lease.readFile('hosted-web/acme/app.js')).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_lease_revoked',
        });
    });

    it('refuses a source whose files each verify but whose complete declared set does not', async () => {
        // Every per-file digest is canonical; only the artifact's whole-graph
        // digest disagrees with the bytes the source hands over.
        const current = fixture(true, 42, null, `sha256:${'e'.repeat(64)}`);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const readFile = vi.fn(async ({ relativePath }: Readonly<{ relativePath: string }>) => (
            current.bytesByPath.get(relativePath) ?? null
        ));

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{ kind: 'appExact', readFile }],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
        expect(readFile).toHaveBeenCalledTimes(current.graph.files.length);
    });

    it('keeps an exact Artifact lease current across an unrelated Availability cursor advance', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{
                kind: 'appExact',
                readFile: async ({ relativePath }) => current.bytesByPath.get(relativePath) ?? null,
            }],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);

        store.replace({ scope, snapshot: fixture(true, 43).snapshot });

        expect(acquired.lease.isCurrent()).toBe(true);
        expect(revoked).not.toHaveBeenCalled();
    });

    it('retires a persistent Artifact lease on an ordinary Availability withdrawal without deleting its verified bytes', async () => {
        // Bootstrap, resume, and every level-triggered AccountChange withdraw the
        // active projection before one coalesced refresh re-supplies it. That is
        // currentness loss, not revocation of the retained bytes: deleting them
        // here costs the same Account a full re-download seconds later.
        const current = fixture(true);
        const custody = persistentCustody(current);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [custody.source],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);

        store.clear();

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(revoked).toHaveBeenCalledTimes(1);
        expect(custody.removePersistentArtifact).not.toHaveBeenCalled();

        // The same Account's next verified snapshot re-admits the identical
        // Artifact and the retained bytes still satisfy it with no re-acquisition.
        store.replace({ scope, snapshot: fixture(true, 43).snapshot });
        const reacquireCustody = persistentCustody(current);
        const daemonRead = vi.fn(async () => null);
        const reacquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [reacquireCustody.source, { kind: 'daemon', readFile: daemonRead }],
        });
        expect(reacquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'persistentCache' } });
        expect(daemonRead).not.toHaveBeenCalled();
        expect(reacquireCustody.removePersistentArtifact).not.toHaveBeenCalled();
    });

    it('leaves a superseded digest to the one owner that holds both verified snapshots', async () => {
        const current = fixture(true);
        const superseded = fixture(true, 43, null, `sha256:${'b'.repeat(64)}`);
        const custody = persistentCustody(current);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [custody.source],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');

        store.replace({ scope, snapshot: superseded.snapshot });

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(custody.removePersistentArtifact).not.toHaveBeenCalled();
    });

    it('still deletes the exact retained entry whose declared file graph no longer verifies', async () => {
        // Corruption is the lease-local deletion trigger the retirement rule
        // deliberately keeps: these bytes can never satisfy the current digest.
        const current = fixture(true);
        const custody = persistentCustody(current);
        const corrupted = Object.freeze({
            ...custody.source,
            readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => {
                await custody.source.readFile({ artifact: {
                    pluginId: slot.pluginId,
                    contributionId: slot.contributionId,
                    tier: slot.tier,
                    platform: slot.platform,
                    digest: current.artifact.digest,
                    releaseVersion: current.artifact.releaseVersion,
                    availabilityCursor: 42,
                }, relativePath });
                return new Uint8Array(current.bytesByPath.get(relativePath)!.byteLength);
            },
        });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [corrupted],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
        expect(custody.removePersistentArtifact).toHaveBeenCalledTimes(1);
    });

    it('keeps freshly persisted verified bytes when the projection withdraws during the write', async () => {
        // The acquisition that just paid for these bytes must not undo itself
        // because a level-triggered AccountChange withdrew the projection while
        // the write was in flight; the Account is unchanged and the very next
        // refresh re-admits the same Artifact.
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{
                kind: 'daemon',
                readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => (
                    current.bytesByPath.get(relativePath) ?? null
                ),
            }],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');

        const removePersistentArtifact = vi.fn(async () => {});
        const written: unknown[] = [];
        const persistent: PluginArtifactLeasePersistentScope = Object.freeze({
            scope,
            store: Object.freeze({
                read: async () => null,
                write: async (record: PluginUiPersistentArtifactRecord) => {
                    written.push(record);
                    store.clear();
                },
                remove: removePersistentArtifact,
                removeAccount: async () => {},
            }),
            isCurrent: () => true,
            removePersistentArtifact,
        });

        await persistVerifiedPluginArtifactLease({ lease: acquired.lease, persistent });

        expect(written).toHaveLength(1);
        expect(acquired.lease.isCurrent()).toBe(false);
        expect(removePersistentArtifact).not.toHaveBeenCalled();
    });

    it('keeps persistent and app-exact Artifact leases current when Account-hosted link provenance changes', async () => {
        const initial = fixture(true, 42, '00000000-0000-4000-8000-000000000001');
        const withoutLink = fixture(true, 43, null);
        const addedLink = fixture(true, 44, '00000000-0000-4000-8000-000000000002');
        const replacementLink = fixture(true, 45, '00000000-0000-4000-8000-000000000003');
        for (const sourceKind of ['persistentCache', 'appExact'] as const) {
            const store = createPluginAccountAvailabilityReaderStore();
            const custody = persistentCustody(initial);
            const source = sourceKind === 'persistentCache'
                ? custody.source
                : {
                    kind: 'appExact' as const,
                    readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => (
                        initial.bytesByPath.get(relativePath) ?? null
                    ),
                };
            store.replace({ scope, snapshot: initial.snapshot });
            const acquired = await acquirePluginSelectedArtifactLease({
                reader: store.bind(scope),
                slot,
                artifactGraph: initial.graph,
                sources: [source],
            });
            if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
            const revoked = vi.fn();
            acquired.lease.onRevoke(revoked);

            for (const next of [withoutLink, addedLink, replacementLink]) {
                store.replace({ scope, snapshot: next.snapshot });
                expect(acquired.lease.isCurrent()).toBe(true);
            }

            expect(revoked).not.toHaveBeenCalled();
            expect(custody.removePersistentArtifact).not.toHaveBeenCalled();
        }
    });
});
