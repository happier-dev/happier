import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { installPluginArtifactCacheBoundary } from '@/dev/testkit/harness/pluginArtifactCacheHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1, PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';

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

import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';

import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import {
    readPluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

const {
    clearPluginAccountAvailabilityProjection,
    forgetPluginAccountAvailabilityArtifacts,
    readPluginAccountAvailability,
    replacePluginAccountAvailabilityProjection,
} = await import('./projection');
import type { PluginAccountAvailabilitySnapshot } from './reader';

let scope: ServerAccountScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

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
        const serverId = await harness.addHome({ name: 'Account artifact custody', serverUrl: 'https://artifact-lifecycle.test', serverIdentityId: 'server-a', accountId: 'account-a' });
        harness.answer(serverId, '/health', { body: {} });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://artifact-lifecycle.test', accountId: 'account-a', request: harness.request });
        scope = Object.freeze({ serverId: connection.home.id, accountId: 'account-a' });
        const { storage } = await import('@/sync/domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
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

    it.each(['cancel', 'publish'] as const)('settles a restored Account native module waiting for initial Availability on %s without retiring the Account', async (settlement) => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { createPluginUiReactNativeInstalledArtifactLoad } = await import('@/sync/domains/plugins/ui/artifactAdoption');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Restored Account lifetime missing');
        clearPluginAccountAvailabilityProjection();
        const bytes = new TextEncoder().encode('exports.renderSurface = () => null;');
        const entry = 'react-native/panel/entry.cjs.bundle';
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entry, bytes }]);
        const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: 'panel', tier: 'reactNative', entry,
            files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
            digest: artifactDigest, builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0',
        });
        await cache.writePersistentArtifact({
            persistentIdentity: { accountScope: scope, artifactDigest }, bytes, entryRelativePath: entry,
            files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength, bytes }],
        });
        const mount = new AbortController();
        let outcome: unknown = null;
        const pending = createPluginUiReactNativeInstalledArtifactLoad({
            reader: readPluginAccountAvailability(scope), accountLifetime: lifetime, artifactGraph,
            identity: { pluginId: 'fixture.pending', contributionId: 'panel', artifactId: 'panel', platform: 'web', artifactDigest },
            moduleReference: undefined, hostPlatform: 'web', isCurrent: () => !mount.signal.aborted,
        })(mount.signal).then(() => { outcome = 'loaded'; }, (error: unknown) => {
            outcome = error instanceof Error && 'code' in error ? error.code : error;
        });
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(outcome).toBeNull();
            if (settlement === 'cancel') {
                mount.abort();
                // Abort retirement is synchronous; its promise continuations must
                // settle before the next event-loop turn, without a new projection.
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(outcome).toBe('artifact_lease_revoked');
            } else {
                const pluginId = 'fixture.pending';
                const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                    availabilityCursor: 2, packageAssets: [], uiArtifacts: [],
                    hostingCapability: { enabled: false },
                    intent: { pluginId, desiredVersion: '1.2.3', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
                    release: {
                        ref: { pluginId, version: '1.2.3' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                        normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.2.3', displayName: 'Pending fixture',
                            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} },
                        collectionContracts: [],
                        uiSlots: [{ contributionId: 'panel', artifactId: 'panel', tier: 'reactNative', platform: 'web', artifactDigest, hostUiApiRange: '^1.0.0' }],
                        packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] },
                    },
                });
                replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                    availabilityCursor: 2, intentReads: [{ pluginId, response }], materializations: [], snapshots: [],
                } });
                await pending;
                expect(outcome).toBe('loaded');
            }
            expect(lifetime.isCurrent()).toBe(true);
        } finally {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: emptySnapshot });
            await pending;
        }
    });

    it('shares one evaluation between concurrent mounts loading the same active content key', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { createPluginUiReactNativeInstalledArtifactLoad } = await import('@/sync/domains/plugins/ui/artifactAdoption');
        const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('@/components/plugins/reactNative/moduleRegistry');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Restored Account lifetime missing');
        const pluginId = 'fixture.shared';
        const bytes = new TextEncoder().encode('exports.renderSurface = () => null;');
        const entry = 'react-native/panel/entry.cjs.bundle';
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entry, bytes }]);
        const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: 'panel', tier: 'reactNative', entry,
            files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
            digest: artifactDigest, builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0',
        });
        await cache.writePersistentArtifact({
            persistentIdentity: { accountScope: scope, artifactDigest }, bytes, entryRelativePath: entry,
            files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength, bytes }],
        });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            availabilityCursor: 2, packageAssets: [], uiArtifacts: [],
            hostingCapability: { enabled: false },
            intent: { pluginId, desiredVersion: '1.2.3', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
            release: {
                ref: { pluginId, version: '1.2.3' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.2.3', displayName: 'Shared fixture',
                    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {} },
                collectionContracts: [],
                uiSlots: [{ contributionId: 'panel', artifactId: 'panel', tier: 'reactNative', platform: 'web', artifactDigest, hostUiApiRange: '^1.0.0' }],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] },
            },
        });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 2, intentReads: [{ pluginId, response }], materializations: [], snapshots: [],
        } });
        // The projection reconciler owns this digest for the current scope.
        const registry = getInstalledPluginReactNativeModuleRegistry();
        registry.reconcileActiveCacheKeys([artifactDigest]);
        const commonJs = createPluginUiCommonJsLoaderBackend();
        let evaluations = 0;
        const backend = { ...commonJs, loadInstalledBundle: async (input: Parameters<NonNullable<typeof commonJs.loadInstalledBundle>>[0]) => {
            evaluations += 1;
            return commonJs.loadInstalledBundle!(input);
        } };
        const mount = () => createPluginUiReactNativeInstalledArtifactLoad({
            reader: readPluginAccountAvailability(scope), accountLifetime: lifetime, artifactGraph, backend,
            identity: { pluginId, contributionId: 'panel', artifactId: 'panel', platform: 'web', artifactDigest },
            moduleReference: undefined, hostPlatform: 'web', isCurrent: () => true,
        })(new AbortController().signal);
        try {
            const [first, second] = await Promise.all([mount(), mount()]);
            expect({ evaluations, sameModule: first === second }).toEqual({ evaluations: 1, sameModule: true });
            // Neither mount committed a render (the first render crashed): the
            // module is not retained, so Retry evaluates a fresh namespace.
            const retried = await mount();
            expect({ evaluations, retainedUncommitted: registry.read(artifactDigest) !== null, fresh: retried !== first })
                .toEqual({ evaluations: 2, retainedUncommitted: false, fresh: true });
        } finally {
            registry.reconcileActiveCacheKeys([]);
            replacePluginAccountAvailabilityProjection({ scope, snapshot: emptySnapshot });
        }
    });

    it('retires an Account switch without deleting its bytes and deletes them only when the Account is forgotten', async () => {
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual(scope);
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
