import { type PackageAssetArchiveOpenedV1 } from '@happier-dev/protocol/plugins/availability';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import type {
    PluginAccountAvailabilityPackageAssetAdmission,
    PluginAccountAvailabilityPackageAssetDescriptor,
    PluginAccountAvailabilityPackageAssetFact,
    PluginAccountAvailabilityReader,
} from './reader';

export type PluginSelectedPackageAssetIdentity = Readonly<{
    pluginId: string;
    releaseVersion: string;
    descriptor: PluginAccountAvailabilityPackageAssetDescriptor;
}>;

/**
 * The Account Artifact reader is the only source for portable package bytes.
 * It has already validated transport, Account currentness, and the generic
 * plain/E2EE envelope before exposing this exact opened archive.
 */
export type PluginProtectedAccountPackageAssetSource = Readonly<{
    readArchive: (input: PluginSelectedPackageAssetIdentity) => Promise<PackageAssetArchiveOpenedV1 | null>;
}>;

/** A revocable renderer-only handle for the selected declared package assets. */
export type PluginSelectedPackageAssetLease = Readonly<{
    readDeclaredAsset: (path: string) => Promise<Uint8Array | null>;
    isCurrent: () => boolean;
    onRevoke: (listener: () => void) => Readonly<{ dispose: () => void }>;
    dispose: () => void;
}>;

export type PluginSelectedPackageAssetLeaseAcquireResult =
    | Readonly<{ kind: 'available'; lease: PluginSelectedPackageAssetLease }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | Extract<PluginAccountAvailabilityPackageAssetAdmission, { kind: 'unavailable' }>['code']
            | 'package_asset_source_unavailable'
            | 'package_asset_source_integrity_invalid'
            | 'package_asset_lease_revoked';
    }>;

function cloneDescriptor(
    descriptor: PluginAccountAvailabilityPackageAssetDescriptor,
): PluginAccountAvailabilityPackageAssetDescriptor {
    return Object.freeze({
        archiveDigestSha256: descriptor.archiveDigestSha256,
        resources: Object.freeze(descriptor.resources.map((resource) => Object.freeze({ ...resource }))),
    });
}

function sameDescriptor(
    left: PluginAccountAvailabilityPackageAssetDescriptor,
    right: PluginAccountAvailabilityPackageAssetDescriptor,
): boolean {
    return left.archiveDigestSha256 === right.archiveDigestSha256
        && left.resources.length === right.resources.length
        && left.resources.every((resource, index) => {
            const other = right.resources[index];
            return other !== undefined
                && resource.resourceId === other.resourceId
                && resource.path === other.path
                && resource.mimeType === other.mimeType
                && resource.byteSize === other.byteSize
                && resource.digestSha256 === other.digestSha256;
        });
}

function cloneIdentity(
    fact: PluginAccountAvailabilityPackageAssetFact,
): PluginSelectedPackageAssetIdentity {
    return Object.freeze({
        pluginId: fact.pluginId,
        releaseVersion: fact.releaseVersion,
        descriptor: cloneDescriptor(fact.descriptor),
    });
}

function sameIdentity(
    identity: PluginSelectedPackageAssetIdentity,
    admission: PluginAccountAvailabilityPackageAssetAdmission,
): boolean {
    return admission.kind === 'available'
        && identity.pluginId === admission.packageAsset.pluginId
        && identity.releaseVersion === admission.packageAsset.releaseVersion
        && sameDescriptor(identity.descriptor, admission.packageAsset.descriptor);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

/**
 * Verifies a protected source's opened archive again against its release-owned
 * descriptor. This makes the lease fail closed if an adapter accidentally
 * exposes an incomplete or substituted entry map.
 */
function archiveMatchesDescriptor(
    archive: PackageAssetArchiveOpenedV1,
    descriptor: PluginAccountAvailabilityPackageAssetDescriptor,
): boolean {
    if (!(archive.resources instanceof Map) || archive.resources.size !== descriptor.resources.length) {
        return false;
    }
    for (const resource of descriptor.resources) {
        const bytes = archive.resources.get(resource.resourceId);
        if (
            !(bytes instanceof Uint8Array)
            || bytes.byteLength !== resource.byteSize
            || computePluginUiArtifactSha256DigestV1(bytes) !== resource.digestSha256
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Acquires one immutable Account-selected package archive with no cache,
 * source ranking, daemon fallback, or deletion authority. Renderer consumers
 * can only read a declared safe path while this release remains current.
 */
export async function acquirePluginSelectedPackageAssetLease(input: Readonly<{
    reader: Pick<PluginAccountAvailabilityReader, 'readCurrentPackageAsset' | 'subscribe'>;
    pluginId: string;
    source: PluginProtectedAccountPackageAssetSource;
}>): Promise<PluginSelectedPackageAssetLeaseAcquireResult> {
    const admission = input.reader.readCurrentPackageAsset({ pluginId: input.pluginId });
    if (admission.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: admission.code });
    }
    const identity = cloneIdentity(admission.packageAsset);
    const revokeListeners = new Set<() => void>();
    let unsubscribe: (() => void) | null = null;
    let revoked = false;
    const revoke = () => {
        if (revoked) return;
        revoked = true;
        unsubscribe?.();
        unsubscribe = null;
        for (const listener of revokeListeners) {
            try {
                listener();
            } catch {
                // One view-local subscriber cannot prevent another from observing revocation.
            }
        }
        revokeListeners.clear();
    };
    const isCurrent = () => {
        if (revoked) return false;
        if (!sameIdentity(identity, input.reader.readCurrentPackageAsset({ pluginId: input.pluginId }))) {
            revoke();
            return false;
        }
        return true;
    };
    unsubscribe = input.reader.subscribe(isCurrent);

    if (!isCurrent()) {
        return Object.freeze({ kind: 'unavailable', code: 'package_asset_lease_revoked' });
    }
    let archive: PackageAssetArchiveOpenedV1 | null;
    try {
        archive = await input.source.readArchive(identity);
    } catch {
        archive = null;
    }
    if (!isCurrent()) {
        return Object.freeze({ kind: 'unavailable', code: 'package_asset_lease_revoked' });
    }
    if (!archive) {
        revoke();
        return Object.freeze({ kind: 'unavailable', code: 'package_asset_source_unavailable' });
    }
    if (!archiveMatchesDescriptor(archive, identity.descriptor)) {
        revoke();
        return Object.freeze({ kind: 'unavailable', code: 'package_asset_source_integrity_invalid' });
    }

    const resourcesByPath = new Map<string, string>();
    for (const resource of identity.descriptor.resources) {
        if (resourcesByPath.has(resource.path)) {
            revoke();
            return Object.freeze({ kind: 'unavailable', code: 'package_asset_source_integrity_invalid' });
        }
        resourcesByPath.set(resource.path, resource.resourceId);
    }

    const lease: PluginSelectedPackageAssetLease = Object.freeze({
        readDeclaredAsset: async (path) => {
            if (!isCurrent()) return null;
            const resourceId = resourcesByPath.get(path);
            const bytes = resourceId ? archive.resources.get(resourceId) : undefined;
            return bytes instanceof Uint8Array && isCurrent() ? copyBytes(bytes) : null;
        },
        isCurrent,
        onRevoke: (listener) => {
            if (revoked) {
                try {
                    listener();
                } catch {
                    // The caller observes an already-revoked lease independently.
                }
                return Object.freeze({ dispose: () => undefined });
            }
            revokeListeners.add(listener);
            return Object.freeze({ dispose: () => revokeListeners.delete(listener) });
        },
        dispose: revoke,
    });
    return Object.freeze({ kind: 'available', lease });
}
