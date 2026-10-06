import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const resourceRead = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock((params) => {
        if (params.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) throw new Error(`Unexpected brand fixture RPC: ${params.method}`);
        return resourceRead();
    });
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let homeId: string;

import {
    PluginProjectionV2Schema,
    DaemonPluginUiResourceReadResponseSchema,
    PluginManifestV2Schema,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import {
    createPackageAssetArchiveV1,
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityPackageAssetPublishActionInputV1Schema,
    PluginAvailabilityPackageAssetReadActionOutputV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginAvailabilityPackageAssetReadActionOutputV1,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

const { readInstalledPluginBrandPresentation } = await import('@/components/plugins/shared/installedPluginBrandPresentation');
import { createValidPluginBrandPngFixture } from '@/dev/testkit/fixtures/pluginImageFixtures';
import { encodeBase64 } from '@/encryption/base64';
const { createActivePluginAccountPackageAssetSource } = await import('@/sync/api/plugins/availability/activePluginAccountPackageAssetRead');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');

const { acquireAndPublishPluginAccountPackageAssets } = await import('./accountPackageAssetPublication');
import { createPluginAccountAvailabilityReader, createPluginAccountAvailabilityReaderStore } from './reader';

describe('portable brand publication and daemon-offline consumption', () => {
    beforeEach(async () => {
        resourceRead.mockReset();
        await harness.reset();
        await loadSyncSingletonForTests();
        homeId = await harness.addHome({ name: 'Brand publication', serverUrl: 'https://brand-publication.test', serverIdentityId: 'server-a', accountId: 'account-a' });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://brand-publication.test', accountId: 'account-a' });
        const { storage } = await import('@/sync/domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: 'account-a' }, isDataReady: true });
    });

    afterEach(async () => {
        await connection?.dispose();
        connection = null;
        await harness.reset();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(storage.getInitialState(), true);
    });

    it.each(['plain', 'e2ee'] as const)('publishes only after opt-in, then a fresh %s client opens the brand with no daemon', async (mode) => {
        const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
        const pluginId = 'acme.portable-brand';
        const bytes = createValidPluginBrandPngFixture();
        const manifest = {
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Portable brand',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            brand: { iconResourceId: 'brand' },
            contributes: { resources: [{ id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }] },
        };
        PluginManifestV2Schema.parse(manifest);
        const archive = createPackageAssetArchiveV1({ manifest, files: [{ path: 'assets/brand.png', bytes }] });
        if (!archive) throw new Error('Expected canonical packaged brand archive.');
        const resource = archive.descriptor.resources[0]!;
        const release = PluginReleaseFactsV1Schema.parse({
            ref: { pluginId, version: manifest.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: manifest, collectionContracts: [], uiSlots: [], packageAssetArchive: archive.descriptor,
        });
        const materialization: PluginMachineMaterializationV1 = {
            serverIdentityId: 'identity-a', machineId: 'machine-a', materializationId: 'installation-a',
            pluginId, version: manifest.version, sourceClass: 'versionedArchive', portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
        };
        const projection = PluginProjectionV2Schema.parse({
            v: 2, generation: 7, familiesById: {}, installedPackagesById: { [pluginId]: {
                id: pluginId, version: manifest.version, displayName: manifest.displayName, enabled: true,
                source: { kind: 'archive', locator: 'package.tgz' }, immutableGenerationId: 'generation-a',
                occurrenceId: 'portable-brand-occurrence-a',
                brand: { state: 'available', resource: { pluginId, localId: 'brand' }, width: 128, height: 128, digest: resource.digestSha256 },
            } },
        });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024 * 1024, maxAccountBytes: 2 * 1024 * 1024 },
            intent: { pluginId, desiredVersion: manifest.version, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
            release, uiArtifacts: [], packageAssets: [],
        });
        const store = createPluginAccountAvailabilityReaderStore();
        const snapshot = {
            availabilityCursor: 1, intentReads: [{ pluginId, response }], materializations: [materialization],
            snapshots: [{ serverIdentityId: 'identity-a', machineId: 'machine-a', materializations: [materialization] }],
        };
        store.replace({ scope, snapshot });
        const stored: { current: PluginAvailabilityPackageAssetReadActionOutputV1 | null } = { current: null };
        const publishPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.packageAsset.publish'];
        const readPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.packageAsset.read'];
        harness.answer(homeId, publishPath, { select: (input) => {
                const payload = PluginAvailabilityPackageAssetPublishActionInputV1Schema.parse(input);
                stored.current = PluginAvailabilityPackageAssetReadActionOutputV1Schema.parse({
                    link: { release: payload.release, artifactId: payload.artifactId, descriptor: archive.descriptor },
                    artifact: { ...payload.artifact, headerVersion: 1, bodyVersion: 1, seq: 0 },
                });
                return { body: { outcome: 'created', link: stored.current.link } };
        } });
        harness.answer(homeId, readPath, { select: () => stored.current ? { body: stored.current } : { status: 404 } });
        const secret = new Uint8Array(32).fill(7);
        const credentials = { token: connection!.credentials.token, ...(mode === 'e2ee' ? { secret: encodeBase64(secret, 'base64url') } : {}) };
        const contentKeyFingerprint = mode === 'e2ee'
            ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(createAccountScopedCryptoMaterialSnapshotV1({
                accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret },
            }).contentPublicKeyFingerprint)
            : null;
        harness.answer(homeId, '/v1/account/encryption', { body: { mode, updatedAt: 0 } });
        harness.answer(homeId, '/v1/account/encryption/currentness', { body: { mode, version: 1, signingKeyFingerprint: null, updatedAt: 0, contentKeyFingerprint } });
        await connection?.dispose();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://brand-publication.test', credentials });
        const { storage } = await import('@/sync/domains/state/storage');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: scope.accountId }, isDataReady: true });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Brand publication requires a restored Account lifetime.');
        resourceRead.mockResolvedValue(DaemonPluginUiResourceReadResponseSchema.parse({
            ok: true, resource: { pluginId, localId: 'brand' }, kind: 'asset',
            contentType: 'image/png', digest: resource.digestSha256, bytesBase64: encodeBase64(bytes, 'base64'),
        }));
        const acquisition = {
            pluginId, reader: store.bind(scope), accountLifetime: lifetime, projection,
            daemon: { serverId: scope.serverId, serverIdentityId: 'identity-a', machineId: 'machine-a' }, isCurrent: () => true,
        };
        await acquireAndPublishPluginAccountPackageAssets(acquisition);
        expect(resourceRead).not.toHaveBeenCalled();
        expect(harness.requestsFor(publishPath)).toHaveLength(0);

        // This is the authoritative projection after the existing present-user consent CAS.
        const optedIn = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            ...response, intent: { ...response.intent, offlineUiHosting: 'enabled', revision: 'intent-2' },
        });
        store.replace({ scope, snapshot: { ...snapshot, intentReads: [{ pluginId, response: optedIn }] } });
        await acquireAndPublishPluginAccountPackageAssets(acquisition);
        expect(resourceRead).toHaveBeenCalledTimes(1);
        expect(stored.current).not.toBeNull();
        if (!stored.current) throw new Error('Expected protected Account publication.');
        const published = stored.current;

        await connection?.dispose();
        resourceRead.mockRejectedValue(new Error('Every daemon is offline.'));
        connection = await restoreServerAccountForTest({ serverUrl: 'https://brand-publication.test', credentials });
        storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...profileDefaults, id: scope.accountId }, isDataReady: true });
        const freshLifetime = captureActiveServerAccountScopeLifetime();
        if (!freshLifetime) throw new Error('Fresh client requires a restored Account lifetime.');
        const freshReader = createPluginAccountAvailabilityReader({ scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [],
            intentReads: [{ pluginId, response: { ...optedIn, packageAssets: [published.link] } }],
        } });
        const source = createActivePluginAccountPackageAssetSource();
        await expect(readInstalledPluginBrandPresentation({
            installedPackage: projection.installedPackagesById[pluginId], machineId: null, serverId: scope.serverId,
            signal: new AbortController().signal, accountLifetime: freshLifetime,
            isCurrent: () => true, packageAssets: { reader: freshReader, source },
        })).resolves.toEqual({ displayName: manifest.displayName, bytes });
        expect(resourceRead).toHaveBeenCalledTimes(1);
        expect(harness.requests.filter((request) => request.path === publishPath || request.path === readPath).map((request) => request.path)).toEqual([publishPath, readPath]);
    });
});
