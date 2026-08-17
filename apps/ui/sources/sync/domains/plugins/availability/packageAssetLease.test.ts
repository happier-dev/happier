import { describe, expect, it, vi } from 'vitest';

import {
    createPackageAssetArchiveV1,
    openPackageAssetArchiveV1,
    type PackageAssetArchiveOpenedV1,
} from '@happier-dev/protocol/plugins/availability';

import type {
    PluginAccountAvailabilityPackageAssetAdmission,
    PluginAccountAvailabilityReader,
} from './reader';
import {
    acquirePluginSelectedPackageAssetLease,
    type PluginProtectedAccountPackageAssetSource,
} from './packageAssetLease';

const pluginId = 'com.acme.package-assets';

function createArchive() {
    const archive = createPackageAssetArchiveV1({
        manifest: {
            schemaVersion: 2,
            id: pluginId,
            version: '1.2.3',
            displayName: 'Package Asset Fixture',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {
                resources: [{
                    id: 'brand-icon',
                    kind: 'asset',
                    path: 'assets/brand.png',
                    contentType: 'image/png',
                }],
            },
        },
        files: [{ path: 'assets/brand.png', bytes: new Uint8Array([1, 2, 3]) }],
    });
    if (!archive) throw new Error('Expected Package Asset archive fixture.');
    const opened = openPackageAssetArchiveV1({
        expectedDescriptor: archive.descriptor,
        header: archive.header,
        body: archive.body,
    });
    if (!opened) throw new Error('Expected opened Package Asset archive fixture.');
    return Object.freeze({ archive, opened });
}

function createReader(
    descriptor = createArchive().archive.descriptor,
) {
    let current: PluginAccountAvailabilityPackageAssetAdmission = Object.freeze({
        kind: 'available',
        availabilityCursor: 42,
        packageAsset: Object.freeze({
            pluginId,
            releaseVersion: '1.2.3',
            descriptor,
        }),
    });
    const listeners = new Set<() => void>();
    const reader: Pick<PluginAccountAvailabilityReader, 'readCurrentPackageAsset' | 'subscribe'> = Object.freeze({
        readCurrentPackageAsset: () => current,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    });
    return Object.freeze({
        reader,
        replace(next: PluginAccountAvailabilityPackageAssetAdmission) {
            current = next;
            for (const listener of [...listeners]) listener();
        },
    });
}

function source(opened: PackageAssetArchiveOpenedV1): PluginProtectedAccountPackageAssetSource {
    return Object.freeze({
        readArchive: vi.fn(async () => opened),
    });
}

describe('selected Package Asset lease', () => {
    it('reads only the descriptor-declared safe path from the one protected Account source', async () => {
        const fixture = createArchive();
        const current = createReader(fixture.archive.descriptor);
        const protectedSource = source(fixture.opened);

        const result = await acquirePluginSelectedPackageAssetLease({
            reader: current.reader,
            pluginId,
            source: protectedSource,
        });

        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error('Expected Package Asset lease.');
        await expect(result.lease.readDeclaredAsset('assets/brand.png'))
            .resolves.toEqual(new Uint8Array([1, 2, 3]));
        await expect(result.lease.readDeclaredAsset('assets/undeclared.png')).resolves.toBeNull();
        await expect(result.lease.readDeclaredAsset('../brand.png')).resolves.toBeNull();
        expect(protectedSource.readArchive).toHaveBeenCalledWith({
            pluginId,
            releaseVersion: '1.2.3',
            descriptor: fixture.archive.descriptor,
        });
        expect(result.lease).not.toHaveProperty('descriptor');
        expect(result.lease).not.toHaveProperty('sourceKind');
    });

    it('revokes when current release facts change while the protected source is awaited', async () => {
        const fixture = createArchive();
        const current = createReader(fixture.archive.descriptor);
        let releaseRead!: (value: PackageAssetArchiveOpenedV1) => void;
        const protectedSource: PluginProtectedAccountPackageAssetSource = Object.freeze({
            readArchive: vi.fn(() => new Promise<PackageAssetArchiveOpenedV1>((resolve) => {
                releaseRead = resolve;
            })),
        });

        const pending = acquirePluginSelectedPackageAssetLease({
            reader: current.reader,
            pluginId,
            source: protectedSource,
        });
        current.replace(Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' }));
        releaseRead(fixture.opened);

        await expect(pending).resolves.toEqual({
            kind: 'unavailable',
            code: 'package_asset_lease_revoked',
        });
    });

    it('fails closed when the protected source cannot corroborate every descriptor entry', async () => {
        const fixture = createArchive();
        const current = createReader(fixture.archive.descriptor);
        const protectedSource = source(Object.freeze({ resources: new Map() }));

        await expect(acquirePluginSelectedPackageAssetLease({
            reader: current.reader,
            pluginId,
            source: protectedSource,
        })).resolves.toEqual({
            kind: 'unavailable',
            code: 'package_asset_source_integrity_invalid',
        });
    });
});
