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
import { acquirePluginSelectedArtifactLease } from './artifactLease';

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
    artifactDigestOverride?: string,
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

    it('keeps persistent and app-exact Artifact leases current when Account-hosted link provenance changes', async () => {
        const initial = fixture(true, 42, '00000000-0000-4000-8000-000000000001');
        const withoutLink = fixture(true, 43, null);
        const addedLink = fixture(true, 44, '00000000-0000-4000-8000-000000000002');
        const replacementLink = fixture(true, 45, '00000000-0000-4000-8000-000000000003');
        for (const sourceKind of ['persistentCache', 'appExact'] as const) {
            const store = createPluginAccountAvailabilityReaderStore();
            const discardRevoked = vi.fn(async () => {});
            const source = sourceKind === 'persistentCache'
                ? {
                    kind: 'persistentCache' as const,
                    readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => (
                        initial.bytesByPath.get(relativePath) ?? null
                    ),
                    discardRevoked,
                }
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
            expect(discardRevoked).not.toHaveBeenCalled();
        }
    });
});
