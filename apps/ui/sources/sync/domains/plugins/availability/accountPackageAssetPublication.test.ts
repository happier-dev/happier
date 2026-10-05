import { describe, expect, it, vi } from 'vitest';

// The real Resource and publication adapters below receive RPC/HTTP boundaries;
// importing them must not initialize an unrelated live socket connection.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { request: vi.fn() } }));

import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import {
    createPackageAssetArchiveV1,
    decodePackageAssetArchiveBodyV1,
    openPackageAssetArchiveV1,
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { PluginSurfaceResourceReadTransport } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import {
    createLifetime,
    createPublisher,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactPublish.testkit';
import { openAccountArtifactStoredEnvelope } from '@/sync/domains/artifacts/accountArtifactEnvelope';

import { acquireAndPublishPluginAccountPackageAssets, observePluginAccountPackageAssetPublication } from './accountPackageAssetPublication';
import { createPluginAccountAvailabilityReaderStore } from './reader';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

function fixture() {
    const pluginId = 'acme.assets';
    const bytes = new TextEncoder().encode('exact packaged resource');
    const manifest = {
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Assets',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        contributes: { resources: [{ id: 'image', kind: 'asset', path: 'assets/image.png', contentType: 'image/png' }] },
    };
    const archive = createPackageAssetArchiveV1({ manifest, files: [{ path: 'assets/image.png', bytes }] });
    if (!archive) throw new Error('Invalid package fixture');
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId, version: '1.0.0' },
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: manifest,
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: archive.descriptor,
    });
    const materialization: PluginMachineMaterializationV1 = {
        serverIdentityId: 'identity-a', machineId: 'machine-a', materializationId: 'install-a',
        pluginId, version: release.ref.version, sourceClass: 'versionedArchive', portableRelease: true,
        archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
    };
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 7,
        hostingCapability: { enabled: true, maxArtifactBytes: 1024 * 1024, maxAccountBytes: 2 * 1024 * 1024 },
        intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
        release, uiArtifacts: [], packageAssets: [],
    });
    const snapshot = {
        availabilityCursor: 7, intentReads: [{ pluginId, response }], materializations: [materialization],
        snapshots: [{ serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId, materializations: [materialization] }],
    };
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope, snapshot });
    const reader = store.bind(scope);
    const projection = PluginProjectionV2Schema.parse({
        v: 2, generation: 19, familiesById: {},
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Assets', version: '1.0.0', enabled: true,
            source: { kind: 'archive', locator: 'package.tgz' }, immutableGenerationId: 'generation-a', occurrenceId: 'assets-occurrence-a' } },
    });
    const { lifetime, retire } = createLifetime(scope);
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body));
        return Response.json({ outcome: 'created', link: { release: release.ref, artifactId: payload.artifactId,
            descriptor: archive.descriptor } });
    });
    const { publisher } = createPublisher({ lifetime, request });
    const resourceRead = vi.fn<PluginSurfaceResourceReadTransport>(async () => ({
        supported: true,
        result: { ok: true, resource: { pluginId, localId: 'image' }, kind: 'asset',
            contentType: 'image/png', digest: archive.descriptor.resources[0]!.digestSha256,
            bytesBase64: encodeBase64(bytes, 'base64') },
    }));
    const input = { pluginId, reader, accountLifetime: lifetime, projection,
        daemon: { serverId: scope.serverId, serverIdentityId: 'identity-a', machineId: 'machine-a' }, isCurrent: () => true };
    return { input, publisher, request, resourceRead, archive, bytes, store, snapshot, retire };
}

describe('exact daemon package-asset publication', () => {
    it('publishes a complete verified asset archive from the selected daemon through the real Account publisher', async () => {
        const current = fixture();
        await expect(acquireAndPublishPluginAccountPackageAssets(current.input, current)).resolves.toMatchObject({ kind: 'published' });
        expect(current.request).toHaveBeenCalledOnce();
        expect(current.resourceRead.mock.calls[0]).toMatchObject(['machine-a', {
            serverId: 'server-a', expectedCallerOccurrenceId: 'assets-occurrence-a', callerPluginId: 'acme.assets',
            resource: { pluginId: 'acme.assets', localId: 'image' },
        }]);
        const payload = JSON.parse(String(current.request.mock.calls[0]![1]?.body));
        const envelope = await openAccountArtifactStoredEnvelope({ mode: 'plain', envelope: payload.artifact });
        if (typeof envelope?.body.body !== 'string') throw new Error('Expected text Package Asset archive');
        const opened = openPackageAssetArchiveV1({ expectedDescriptor: current.archive.descriptor,
            header: envelope.header, body: decodePackageAssetArchiveBodyV1(envelope.body.body) });
        expect(opened?.resources.get('image')).toEqual(current.bytes);
    });

    it.each(['wrongMachine', 'wrongServer', 'releaseConflict', 'localPath', 'untrusted', 'disabled', 'uncommitted'] as const)(
        'does not acquire from a %s source or select a different materialization', async (failure) => {
            const current = fixture();
            const materialization = current.snapshot.materializations[0]!;
            if (failure === 'wrongMachine') current.input.daemon.machineId = 'machine-b';
            if (failure === 'wrongServer') current.input.daemon.serverIdentityId = 'identity-b';
            if (failure === 'releaseConflict') materialization.archiveDigestSha256 = `sha256:${'b'.repeat(64)}`;
            if (failure === 'localPath') materialization.portableRelease = false;
            if (failure === 'untrusted') materialization.trustState = 'untrusted';
            if (failure === 'disabled') current.input.projection.installedPackagesById[current.input.pluginId]!.enabled = false;
            if (failure === 'uncommitted') delete current.input.projection.installedPackagesById[current.input.pluginId]!.immutableGenerationId;
            current.store.replace({ scope, snapshot: current.snapshot });
            await acquireAndPublishPluginAccountPackageAssets(current.input, current);
            expect(current.resourceRead).not.toHaveBeenCalled();
            expect(current.request).not.toHaveBeenCalled();
        },
    );

    it.each(['foreign-server', null])('rejects routing outside the captured Account server: %s', async (serverId) => {
        const current = fixture();
        await acquireAndPublishPluginAccountPackageAssets({ ...current.input,
            daemon: { ...current.input.daemon, serverId },
        }, current);
        expect(current.resourceRead).not.toHaveBeenCalled();
    });

    it('rejects a local path projection even when an older portable materialization remains in the Account inventory', async () => {
        const current = fixture();
        current.input.projection.installedPackagesById[current.input.pluginId]!.source.kind = 'path';
        await acquireAndPublishPluginAccountPackageAssets(current.input, current);
        expect(current.resourceRead).not.toHaveBeenCalled();
    });

    it('keeps one mounted acquisition across unrelated refresh and disposes its Resource request', async () => {
        const current = fixture();
        const completion = createDeferred<Awaited<ReturnType<PluginSurfaceResourceReadTransport>>>();
        current.resourceRead.mockImplementation(() => completion.promise);
        const dispose = observePluginAccountPackageAssetPublication(current.input, current);
        expect(current.resourceRead).toHaveBeenCalledOnce();
        const signal = current.resourceRead.mock.calls[0]![1].signal;
        current.store.replace({ scope, snapshot: { ...current.snapshot, availabilityCursor: 8,
            intentReads: current.snapshot.intentReads.map((entry) => ({ ...entry,
                response: { ...entry.response, availabilityCursor: 8 },
            })),
        } });
        expect(current.resourceRead).toHaveBeenCalledOnce();
        expect(signal?.aborted).toBe(false);
        dispose();
        expect(signal?.aborted).toBe(true);
        completion.resolve({ supported: false, reason: 'not-supported' });
        await completion.promise;
        expect(current.request).not.toHaveBeenCalled();
    });

    it.each(['mime', 'digest', 'size', 'bytes'] as const)('rejects an archive with wrong %s', async (failure) => {
        const current = fixture();
        current.resourceRead.mockImplementation(async () => ({ supported: true, result: {
            ok: true, resource: { pluginId: current.input.pluginId, localId: 'image' }, kind: 'asset',
            contentType: failure === 'mime' ? 'text/html' : 'image/png',
            digest: failure === 'digest' ? `sha256:${'b'.repeat(64)}` : current.archive.descriptor.resources[0]!.digestSha256,
            bytesBase64: encodeBase64(failure === 'size' ? new Uint8Array(1)
                : failure === 'bytes' ? new Uint8Array(current.bytes.length) : current.bytes, 'base64'),
        } }));
        await acquireAndPublishPluginAccountPackageAssets(current.input, current);
        expect(current.request).not.toHaveBeenCalled();
    });

    it('continues exact-source acquisition across an unrelated Account availability change', async () => {
        const current = fixture();
        const read = current.resourceRead.getMockImplementation()!;
        current.resourceRead.mockImplementation(async (machineId, options) => {
            current.store.replace({ scope, snapshot: {
                ...current.snapshot,
                availabilityCursor: 8,
                intentReads: current.snapshot.intentReads.map((entry) => ({ ...entry,
                    response: { ...entry.response, availabilityCursor: 8 },
                })),
            } });
            return read(machineId, options);
        });
        await expect(acquireAndPublishPluginAccountPackageAssets(current.input, current)).resolves.toMatchObject({ kind: 'published' });
        expect(current.resourceRead).toHaveBeenCalledOnce();
    });

    it.each(['account', 'availability', 'projection', 'cancelled'] as const)(
        'does not publish after %s changes during Resource acquisition', async (failure) => {
            const current = fixture();
            const abort = new AbortController();
            let capturedSignal: AbortSignal | undefined;
            current.resourceRead.mockImplementation(async (_machineId, options) => {
                capturedSignal = options.signal;
                if (failure === 'account') current.retire();
                if (failure === 'availability') current.store.clear();
                if (failure === 'projection') current.input.projection.generation += 1;
                if (failure === 'cancelled') abort.abort();
                return { supported: true, result: { ok: true,
                    resource: { pluginId: current.input.pluginId, localId: 'image' }, kind: 'asset',
                    contentType: 'image/png', digest: current.archive.descriptor.resources[0]!.digestSha256,
                    bytesBase64: encodeBase64(current.bytes, 'base64'),
                } };
            });
            await acquireAndPublishPluginAccountPackageAssets({ ...current.input, signal: abort.signal }, current);
            expect(current.request).not.toHaveBeenCalled();
            if (failure !== 'projection') expect(capturedSignal?.aborted).toBe(true);
        },
    );
});
