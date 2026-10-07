import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { installPluginArtifactCacheBoundary } from '@/dev/testkit/harness/pluginArtifactCacheHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

const persistence = installPluginArtifactCacheBoundary();
afterAll(() => persistence.dispose());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
const cache = getInstalledPluginReactNativeBundleCache();
const { createBrowserPluginUiPersistentArtifactStore } = await import('@/sync/domains/plugins/ui/artifactByteCache.browser');
const physicalStore = createBrowserPluginUiPersistentArtifactStore(persistence.caches);

import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import {
    readPluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

const {
    clearPluginAccountAvailabilityProjection,
    forgetPluginAccountAvailabilityArtifacts,
    replacePluginAccountAvailabilityProjection,
} = await import('./projection');
import type { PluginAccountAvailabilitySnapshot } from './reader';

const scope: ServerAccountScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

const emptySnapshot: PluginAccountAvailabilitySnapshot = Object.freeze({
    availabilityCursor: 1,
    intentReads: Object.freeze([]),
    materializations: Object.freeze([]),
    snapshots: Object.freeze([]),
});

async function seedArtifact() {
    const bytes = new TextEncoder().encode('// retained Account artifact');
    const persistentIdentity = { accountScope: scope, artifactDigest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: 'entry.js', bytes }]) };
    expect(await cache.writePersistentArtifact({ persistentIdentity, bytes, entryRelativePath: 'entry.js', files: [{ relativePath: 'entry.js', digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength, bytes }] })).toBe(true);
    return { persistentIdentity, bytes };
}

describe('Account artifact-byte lifecycle', () => {
    beforeEach(async () => {
        clearPluginAccountAvailabilityProjection();
        persistence.reset();
        await harness.reset();
        await loadSyncSingletonForTests();
        await harness.addHome({ name: 'Account artifact custody', serverUrl: 'https://artifact-lifecycle.test', serverIdentityId: scope.serverId, accountId: scope.accountId });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://artifact-lifecycle.test', accountId: scope.accountId });
        const { storage } = await import('@/sync/domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: scope.accountId }, isDataReady: true });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: emptySnapshot });
    });

    afterEach(async () => {
        persistence.rejectDeletes(false);
        await cache.removePersistentArtifactsForAccount(scope);
        await connection?.dispose();
        connection = null;
        clearPluginAccountAvailabilityProjection();
        await harness.reset();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(storage.getInitialState(), true);
    });

    it('retires an Account switch without deleting its bytes and deletes them only when the Account is forgotten', async () => {
        const artifact = await seedArtifact();
        expect(cache.isAccountCurrent(scope)).toBe(true);

        // Account switch / deactivation: reachability retires immediately and
        // the Account-qualified bytes stay inert so returning to the same
        // Account does not force a full re-download.
        await connection?.dispose();
        clearPluginAccountAvailabilityProjection();
        expect(cache.isAccountCurrent(scope)).toBe(false);
        await expect(cache.readPersistentArtifact(artifact.persistentIdentity)).resolves.toBeNull();
        await expect(physicalStore.read(artifact.persistentIdentity)).resolves.toMatchObject({ bytes: artifact.bytes });

        // Logout / forget Account / explicit clear: the same bytes are deleted.
        forgetPluginAccountAvailabilityArtifacts(scope);
        await waitForHomeGovernance(async () => expect(await physicalStore.read(artifact.persistentIdentity)).toBeNull());
    });

    it('keeps the retained admission snapshot across a switch and drops it when the Account is forgotten', async () => {
        await prepareWarmCacheEncryptionKey();
        const target = { targetKey: 'server-a:machine-a', machineId: 'machine-a' } as const;
        savePluginUiProjectionAdmissionSnapshot({
            scope,
            ...target,
            projection: PluginProjectionV2Schema.parse({
                v: 2,
                generation: 7,
                familiesById: {
                    pluginUi: {
                        family: 'pluginUi',
                        entriesById: {
                            'translations:acme.preview': {
                                id: 'translations:acme.preview',
                                pluginId: 'acme.preview',
                                occurrenceId: 'preview-occurrence',
                                contributionKind: 'translations',
                                locales: ['en'],
                                bundles: { en: { title: 'Retained' } },
                            },
                        },
                    },
                },
            }),
        });
        expect(readPluginUiProjectionAdmissionSnapshot({ scope, ...target })).not.toBeNull();

        // Account switch / deactivation retires reachability only.
        await connection?.dispose();
        clearPluginAccountAvailabilityProjection();
        expect(readPluginUiProjectionAdmissionSnapshot({ scope, ...target })).not.toBeNull();

        forgetPluginAccountAvailabilityArtifacts(scope);
        expect(readPluginUiProjectionAdmissionSnapshot({ scope, ...target })).toBeNull();
    });

    it('does not let a failed Account deletion escape the cache owner', async () => {
        const artifact = await seedArtifact();
        persistence.rejectDeletes(true);

        expect(() => forgetPluginAccountAvailabilityArtifacts(scope)).not.toThrow();
        await waitForHomeGovernance(() => expect(persistence.deletionAttempts).toBeGreaterThan(0));
        // Failed physical deletion leaves bytes in the SDK, but the real
        // custody quarantine must make those forgotten bytes unreadable.
        await expect(cache.readPersistentArtifact(artifact.persistentIdentity)).resolves.toBeNull();
    });
});
