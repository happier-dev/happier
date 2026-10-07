import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { installPluginArtifactCacheBoundary } from '@/dev/testkit/harness/pluginArtifactCacheHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const persistence = installPluginArtifactCacheBoundary();
afterAll(() => persistence.dispose());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
const cache = getInstalledPluginReactNativeBundleCache();
const {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
} = await import('./projection');
import type { PluginAccountAvailabilitySnapshot } from './reader';

const scope: ServerAccountScope = Object.freeze({ serverId: 'srv-local-a', accountId: 'account-a' });
const slot = Object.freeze({
    pluginId: 'com.acme.fixture',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});

function snapshotWith(input: Readonly<{
    availabilityCursor: number;
    /** Absent means the Account no longer names any release for the plugin. */
    version?: string;
    enabled?: boolean;
}>): PluginAccountAvailabilitySnapshot {
    if (!input.version) {
        return Object.freeze({
            availabilityCursor: input.availabilityCursor,
            intentReads: Object.freeze([]),
            materializations: Object.freeze([]),
            snapshots: Object.freeze([]),
        });
    }
    const entryBytes = new TextEncoder().encode(`<!doctype html><!-- ${input.version} -->`);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: 'index.html', bytes: entryBytes },
    ]);
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: input.availabilityCursor,
        packageAssets: [],
        hostingCapability: { enabled: false },
        intent: {
            pluginId: slot.pluginId,
            desiredVersion: input.version,
            enabled: input.enabled ?? true,
            offlineUiHosting: 'disabled',
            writableCollections: [],
            revision: `intent-${input.version}`,
        },
        release: {
            ref: { pluginId: slot.pluginId, version: input.version },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: slot.pluginId,
                version: input.version,
                displayName: 'Fixture',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                contributes: {},
            },
            collectionContracts: [],
            uiSlots: [{
                contributionId: slot.contributionId,
                artifactId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: digest,
                hostUiApiRange: '^1.0.0',
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        },
        uiArtifacts: [],
    });
    return Object.freeze({
        availabilityCursor: input.availabilityCursor,
        intentReads: Object.freeze([{ pluginId: slot.pluginId, response }]),
        materializations: Object.freeze([]),
        snapshots: Object.freeze([]),
    });
}

async function seedRetainedArtifact() {
    const bytes = new TextEncoder().encode('<!doctype html><!-- 1.2.3 -->');
    const persistentIdentity = { accountScope: scope, artifactDigest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: 'index.html', bytes }]) };
    expect(await cache.writePersistentArtifact({ persistentIdentity, bytes, entryRelativePath: 'index.html', files: [{ relativePath: 'index.html', digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength, bytes }] })).toBe(true);
    return { bytes, persistentIdentity };
}

describe('Availability projection artifact retention', () => {
    beforeEach(async () => {
        clearPluginAccountAvailabilityProjection();
        persistence.reset();
        await harness.reset();
        await loadSyncSingletonForTests();
        await harness.addHome({ name: 'Artifact retention', serverUrl: 'https://artifact-retention.test', serverIdentityId: scope.serverId, accountId: scope.accountId });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://artifact-retention.test', accountId: scope.accountId });
        const { storage } = await import('@/sync/domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: scope.accountId }, isDataReady: true });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: snapshotWith({ availabilityCursor: 0 }) });
    });

    afterEach(async () => {
        await cache.removePersistentArtifactsForAccount(scope);
        await connection?.dispose();
        connection = null;
        clearPluginAccountAvailabilityProjection();
        await harness.reset();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(storage.getInitialState(), true);
    });

    it('retains A across A -> B -> A rather than deleting it when the projection names B', async () => {
        // Ordinary projection replacement is not a deletion authority: retiring
        // reachability is what stops A from being used while B is current, and
        // returning to A must not cost a full re-download (PEP master decision
        // 9; PEP-ARTIFACTS 8.2).
        const artifact = await seedRetainedArtifact();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2, version: '2.0.0' }),
        });
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 3, version: '1.2.3' }),
        });

        await expect(cache.readPersistentArtifact(artifact.persistentIdentity)).resolves.toMatchObject({ bytes: artifact.bytes });
    });

    it('retains the withdrawn entry across the clear the refresh performs first', async () => {
        const artifact = await seedRetainedArtifact();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });

        // Every level-triggered AccountChange withdraws the projection before its
        // one coalesced refresh replaces it. Withdrawal retires reachability; the
        // bytes stay inert until logout, forget, explicit clear or corruption.
        clearPluginAccountAvailabilityProjection();
        await expect(cache.readPersistentArtifact(artifact.persistentIdentity)).resolves.toMatchObject({ bytes: artifact.bytes });

        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2 }),
        });

        await expect(cache.readPersistentArtifact(artifact.persistentIdentity)).resolves.toMatchObject({ bytes: artifact.bytes });
    });

    it('retains the entry when the Account disables the plugin but still names its release', async () => {
        // Disable prevents new invocation and renderer adoption while retaining
        // the bounded archives (PEP-ARTIFACTS 10.1); re-enabling must not cost a
        // full re-download.
        const artifact = await seedRetainedArtifact();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2, version: '1.2.3', enabled: false }),
        });

        await expect(cache.readPersistentArtifact(artifact.persistentIdentity)).resolves.toMatchObject({ bytes: artifact.bytes });
    });

    it('retains the entry when the same release survives the clear and refresh', async () => {
        const artifact = await seedRetainedArtifact();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });
        clearPluginAccountAvailabilityProjection();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2, version: '1.2.3' }),
        });

        await expect(cache.readPersistentArtifact(artifact.persistentIdentity)).resolves.toMatchObject({ bytes: artifact.bytes });
    });
});
