import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { verifyPluginUiArtifactBytesIntegrityV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginReactNativeBundleCacheIdentity } from './bundleCache';

const INSTALLED_ARTIFACT_DIRECTORY = 'happier-rn-installed-artifacts-v1';

type ExpoFileSystemDirectory = Readonly<{
    uri: string;
    exists?: boolean;
    create: (options?: { intermediates?: boolean; idempotent?: boolean }) => void;
    delete?: (options?: { idempotent?: boolean }) => void;
}>;

type ExpoFileSystemFile = Readonly<{
    uri: string;
    exists: boolean;
    size: number;
    bytes: () => Promise<Uint8Array>;
    write: (content: Uint8Array, options?: { append?: boolean }) => void;
    delete?: () => void;
}>;

type ExpoFileSystemModule = Readonly<{
    Directory: new (...uris: Array<ExpoFileSystemDirectory | string>) => ExpoFileSystemDirectory;
    File: new (...uris: Array<ExpoFileSystemDirectory | string>) => ExpoFileSystemFile;
    Paths?: Readonly<{
        cache?: ExpoFileSystemDirectory | string | null;
    }>;
}>;

export type ReactNativeInstalledArtifactFileMaterializer = (input: Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    bytes: Uint8Array;
    scriptId: string;
    file?: Readonly<{
        relativePath: string;
        digest: string;
        byteSize: number;
    }>;
}>) => Promise<string>;

export type ReactNativeInstalledArtifactFileMaterializerOptions = Readonly<{
    fileSystem?: ExpoFileSystemModule;
}>;

function sha256Hex(value: string): string {
    return bytesToHex(sha256(utf8ToBytes(value)));
}

function digestFileNamePart(digest: string): string {
    return digest.trim().toLowerCase().replace(/^sha256:/u, 'sha256-').replace(/[^a-f0-9-]/gu, '_');
}

function createCanonicalMaterializerIdentity(
    identity: PluginReactNativeBundleCacheIdentity,
): string {
    const fields: readonly (readonly [string, string])[] = [
        ['pluginId', identity.pluginId],
        ['contributionId', identity.contributionId],
        ['platform', identity.platform],
        ['channel', identity.channel],
        ['artifactDigest', identity.artifactDigest],
        ['projectionGeneration', String(identity.projectionGeneration)],
        ['hostAppVersion', identity.hostAppVersion],
        ['hostUiApiVersion', identity.hostUiApiVersion],
        ['reactVersion', identity.reactVersion],
        ['reactNativeVersion', identity.reactNativeVersion],
        ['expoRuntimeVersion', identity.expoRuntimeVersion ?? ''],
        ['hermesVersion', identity.hermesVersion ?? ''],
        ['nativeCapabilitiesDigest', identity.nativeCapabilitiesDigest],
    ];
    return fields
        .map(([key, value]) => {
            const bytes = utf8ToBytes(value);
            return `${key}:${bytes.byteLength}:${value}`;
        })
        .join('\n');
}

/**
 * RN-3: the per-identity on-disk directory name for a materialized installed
 * artifact. It is derived from the canonical cache identity ALONE (not the scriptId),
 * so disk-level GC can recompute the exact directory to delete from a cache identity
 * without tracking a side index. Every materialized file for one identity lives under
 * this directory, so deleting it removes the revoked executable bytes from disk.
 */
export function resolveMaterializedArtifactDirectoryName(
    identity: PluginReactNativeBundleCacheIdentity,
): string {
    return sha256Hex(createCanonicalMaterializerIdentity(identity));
}

async function resolveExpoFileSystem(
    options: ReactNativeInstalledArtifactFileMaterializerOptions,
): Promise<ExpoFileSystemModule> {
    if (options.fileSystem) return options.fileSystem;
    return await import('expo-file-system') as ExpoFileSystemModule;
}

function resolveCacheDirectory(FileSystem: ExpoFileSystemModule): ExpoFileSystemDirectory {
    const cachePath = FileSystem.Paths?.cache ?? null;
    if (!cachePath) {
        throw new Error('React Native installed artifact materializer requires a native cache directory');
    }
    const cacheDirectory = typeof cachePath === 'string'
        ? new FileSystem.Directory(cachePath)
        : cachePath;
    assertFileUri(cacheDirectory.uri);
    return cacheDirectory;
}

function ensureVerifiedInputBytes(input: Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    bytes: Uint8Array;
    digest?: string;
}>): void {
    const integrity = verifyPluginUiArtifactBytesIntegrityV1({
        bytes: input.bytes,
        integrity: {
            digest: input.digest ?? input.identity.artifactDigest,
            pluginId: input.identity.pluginId,
            contributionId: input.identity.contributionId,
            artifactKind: 'reactNativeBundle',
        },
    });
    if (!integrity.ok) {
        throw new Error(integrity.reasonCode);
    }
}

async function fileMatchesExpectedArtifact(input: Readonly<{
    file: ExpoFileSystemFile;
    identity: PluginReactNativeBundleCacheIdentity;
    digest?: string;
    byteSize: number;
}>): Promise<boolean> {
    try {
        if (!input.file.exists || input.file.size !== input.byteSize) return false;
        const bytes = await input.file.bytes();
        const integrity = verifyPluginUiArtifactBytesIntegrityV1({
            bytes,
            integrity: {
                digest: input.digest ?? input.identity.artifactDigest,
                pluginId: input.identity.pluginId,
                contributionId: input.identity.contributionId,
                artifactKind: 'reactNativeBundle',
            },
        });
        return integrity.ok;
    } catch {
        return false;
    }
}

function assertFileUri(uri: string): void {
    if (!uri.startsWith('file://')) {
        throw new Error('React Native installed artifact materializer must materialize to a file:// URL');
    }
}

export function createReactNativeInstalledArtifactFileMaterializer(
    options: ReactNativeInstalledArtifactFileMaterializerOptions = {},
): ReactNativeInstalledArtifactFileMaterializer {
    return async ({ identity, bytes, scriptId, file: artifactFile }) => {
        const digest = artifactFile?.digest ?? identity.artifactDigest;
        const expectedByteSize = artifactFile?.byteSize ?? bytes.byteLength;
        if (bytes.byteLength !== expectedByteSize) {
            throw new Error('react_native_installed_artifact_file_size_mismatch');
        }
        ensureVerifiedInputBytes({ identity, bytes, digest });

        const FileSystem = await resolveExpoFileSystem(options);
        const cacheDirectory = resolveCacheDirectory(FileSystem);

        const identityHash = resolveMaterializedArtifactDirectoryName(identity);
        const scriptHash = sha256Hex(scriptId);
        const directory = new FileSystem.Directory(
            cacheDirectory,
            INSTALLED_ARTIFACT_DIRECTORY,
            identityHash,
        );
        directory.create({ intermediates: true, idempotent: true });

        const materializedFile = new FileSystem.File(
            directory,
            `${digestFileNamePart(digest)}.${scriptHash}.bundle.js`,
        );
        assertFileUri(materializedFile.uri);

        if (await fileMatchesExpectedArtifact({
            file: materializedFile,
            identity,
            digest,
            byteSize: expectedByteSize,
        })) {
            return materializedFile.uri;
        }

        try {
            materializedFile.delete?.();
        } catch {
            // Best effort: File.write with append false should overwrite on current Expo FileSystem.
        }
        materializedFile.write(bytes, { append: false });

        if (!await fileMatchesExpectedArtifact({
            file: materializedFile,
            identity,
            digest,
            byteSize: expectedByteSize,
        })) {
            throw new Error('react_native_installed_artifact_file_digest_mismatch');
        }
        return materializedFile.uri;
    };
}

export type ReactNativeInstalledArtifactDiskGc = Readonly<{
    /**
     * RN-3: delete the on-disk materialized bundle directory for each cache identity.
     * Tied to in-memory cache eviction (uninstall / disable)
     * so revoked or removed executable bytes are deleted from disk, not just dropped
     * from the in-memory cache. Best-effort and idempotent: a missing directory is a
     * no-op, and a delete failure for one identity never blocks the others.
     */
    evictForIdentities: (
        identities: readonly PluginReactNativeBundleCacheIdentity[],
    ) => Promise<void>;
}>;

export function createReactNativeInstalledArtifactDiskGc(
    options: ReactNativeInstalledArtifactFileMaterializerOptions = {},
): ReactNativeInstalledArtifactDiskGc {
    return Object.freeze({
        evictForIdentities: async (identities) => {
            if (identities.length === 0) {
                return;
            }
            let FileSystem: ExpoFileSystemModule;
            let cacheDirectory: ExpoFileSystemDirectory;
            try {
                FileSystem = await resolveExpoFileSystem(options);
                cacheDirectory = resolveCacheDirectory(FileSystem);
            } catch {
                // No native file system (web/test) → nothing materialized to delete.
                return;
            }

            const deletedDirectoryNames = new Set<string>();
            for (const identity of identities) {
                const directoryName = resolveMaterializedArtifactDirectoryName(identity);
                if (deletedDirectoryNames.has(directoryName)) {
                    continue;
                }
                deletedDirectoryNames.add(directoryName);
                try {
                    const directory = new FileSystem.Directory(
                        cacheDirectory,
                        INSTALLED_ARTIFACT_DIRECTORY,
                        directoryName,
                    );
                    if (directory.exists === false) {
                        continue;
                    }
                    directory.delete?.({ idempotent: true });
                } catch {
                    // Best effort: a failed delete for one identity must not block the rest.
                }
            }
        },
    });
}
