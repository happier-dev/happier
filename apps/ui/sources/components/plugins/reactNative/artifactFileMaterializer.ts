import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactDigestV1Schema,
    verifyPluginUiArtifactBytesIntegrityV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
    type PluginUiPersistentArtifactFile,
    type PluginUiPersistentArtifactIdentity,
    type PluginUiPersistentArtifactNativeStoredResource,
    type PluginUiPersistentArtifactNativeResourceStore,
    type PluginUiPersistentArtifactRecord,
} from '@/sync/domains/plugins/ui/artifactByteCache';

const INSTALLED_ARTIFACT_DIRECTORY = 'happier-rn-installed-artifacts-v1';
const PERSISTENT_ARTIFACT_DIRECTORY = 'happier-plugin-ui-artifacts-v1';
const PERSISTENT_ARTIFACT_MANIFEST = 'record.v1.json';
const PERSISTENT_STORED_FILE_NAME_PATTERN = /^[a-f0-9]{64}\.bin$/u;

type ExpoFileSystemDirectory = Readonly<{
    uri: string;
    exists?: boolean;
    create: (options?: { intermediates?: boolean; idempotent?: boolean }) => void;
    delete?: () => void;
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
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
    }>;
}>) => Promise<string>;

export type ReactNativeInstalledArtifactFileMaterializerOptions = Readonly<{
    fileSystem?: ExpoFileSystemModule;
}>;

function sha256Hex(value: string): string {
    return bytesToHex(sha256(utf8ToBytes(value)));
}

function digestFileNamePart(digest: PluginUiArtifactDigestV1): string {
    return digest.trim().toLowerCase().replace(/^sha256:/u, 'sha256-').replace(/[^a-f0-9-]/gu, '_');
}

function createCanonicalMaterializerIdentity(
    identity: PluginReactNativeBundleCacheIdentity,
): string {
    const fields: readonly (readonly [string, string])[] = [
        ['pluginId', identity.pluginId],
        ['contributionId', identity.contributionId],
        ['platform', identity.platform],
        ['artifactDigest', identity.artifactDigest],
    ];
    return fields
        .map(([key, value]) => {
            const bytes = utf8ToBytes(value);
            return `${key}:${bytes.byteLength}:${value}`;
        })
        .join('\n');
}

/**
 * RN-3: the per-artifact on-disk directory name for a materialized installed
 * artifact. It is derived from immutable executable identity alone (not the scriptId),
 * so disk-level GC can recompute the exact directory to delete from a cache identity
 * without tracking a side index. Transient host compatibility and projection-generation
 * facts intentionally do not participate: changing those facts must re-admit the artifact,
 * but must not rewrite identical digest-verified bytes.
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
    digest?: PluginUiArtifactDigestV1;
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

type PersistentArtifactManifestV1 = Readonly<{
    v: 1;
    identityKey: string;
    entryRelativePath?: string;
    files: readonly Readonly<{
        relativePath: string;
        digest: PluginUiArtifactDigestV1;
        byteSize: number;
        storedName: string;
    }>[];
}>;

function resolvePersistentAccountDirectoryName(identity: PluginUiPersistentArtifactIdentity): string {
    return sha256Hex(derivePluginUiPersistentArtifactAccountKey(identity.accountScope));
}

function resolvePersistentArtifactDirectoryName(identity: PluginUiPersistentArtifactIdentity): string {
    return sha256Hex(derivePluginUiPersistentArtifactKey(identity));
}

function persistentStoredFileName(relativePath: string): string {
    return `${sha256Hex(relativePath)}.bin`;
}

function readPersistentRecordFiles(record: PluginUiPersistentArtifactRecord): readonly PluginUiPersistentArtifactFile[] {
    if (record.files?.length) return record.files;
    return Object.freeze([{
        relativePath: record.entryRelativePath ?? '__entry__',
        digest: record.persistentIdentity.artifactDigest,
        byteSize: record.bytes.byteLength,
        bytes: record.bytes,
    }]);
}

function createPersistentArtifactDirectory(
    FileSystem: ExpoFileSystemModule,
    cacheDirectory: ExpoFileSystemDirectory,
    identity: PluginUiPersistentArtifactIdentity,
): ExpoFileSystemDirectory {
    return new FileSystem.Directory(
        cacheDirectory,
        PERSISTENT_ARTIFACT_DIRECTORY,
        resolvePersistentAccountDirectoryName(identity),
        resolvePersistentArtifactDirectoryName(identity),
    );
}

function createPersistentAccountDirectory(
    FileSystem: ExpoFileSystemModule,
    cacheDirectory: ExpoFileSystemDirectory,
    scope: PluginUiPersistentArtifactIdentity['accountScope'],
): ExpoFileSystemDirectory {
    return new FileSystem.Directory(
        cacheDirectory,
        PERSISTENT_ARTIFACT_DIRECTORY,
        sha256Hex(derivePluginUiPersistentArtifactAccountKey(scope)),
    );
}

function deletePersistentArtifactDirectory(artifactDirectory: ExpoFileSystemDirectory): void {
    if (artifactDirectory.exists === false) return;
    if (!artifactDirectory.delete) {
        throw new Error('plugin_ui_artifact_cache_delete_unavailable');
    }
    artifactDirectory.delete();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePersistentManifest(bytes: Uint8Array): PersistentArtifactManifestV1 | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!isRecord(value)) return null;
        if (
            value.v !== 1
            || typeof value.identityKey !== 'string'
            || !Array.isArray(value.files)
            || value.files.length === 0
        ) return null;
        const files: PersistentArtifactManifestV1['files'][number][] = [];
        for (const file of value.files) {
            if (
                !isRecord(file)
                || typeof file.relativePath !== 'string'
                || typeof file.byteSize !== 'number'
                || !Number.isSafeInteger(file.byteSize)
                || file.byteSize < 0
                || typeof file.storedName !== 'string'
            ) return null;
            const digest = PluginUiArtifactDigestV1Schema.safeParse(file.digest);
            if (!digest.success) return null;
            files.push(Object.freeze({
                relativePath: file.relativePath,
                digest: digest.data,
                byteSize: file.byteSize,
                storedName: file.storedName,
            }));
        }
        return Object.freeze({
            v: 1,
            identityKey: value.identityKey,
            ...(typeof value.entryRelativePath === 'string'
                ? { entryRelativePath: value.entryRelativePath }
                : {}),
            files: Object.freeze(files),
        });
    } catch {
        return null;
    }
}

export type ReactNativePersistentArtifactStoreOptions = ReactNativeInstalledArtifactFileMaterializerOptions
    & Readonly<{
        onCleanupDiagnostic?: (code: string) => void;
    }>;

/**
 * The native adapter for the one persistent verified Plugin UI byte cache.
 * The manifest is written last and acts as the commit marker: partial file writes
 * are never readable after a crash. Paths contain only hashes of Account/artifact
 * coordinates and live beneath Expo's app-private cache directory.
 */
export function createReactNativePersistentArtifactStore(
    options: ReactNativePersistentArtifactStoreOptions = {},
): PluginUiPersistentArtifactNativeResourceStore {
    const resolveDirectories = async (identity: PluginUiPersistentArtifactIdentity) => {
        const FileSystem = await resolveExpoFileSystem(options);
        const cacheDirectory = resolveCacheDirectory(FileSystem);
        return {
            FileSystem,
            accountDirectory: createPersistentAccountDirectory(FileSystem, cacheDirectory, identity.accountScope),
            artifactDirectory: createPersistentArtifactDirectory(FileSystem, cacheDirectory, identity),
        };
    };

    return Object.freeze({
        read: async (identity) => {
            const { FileSystem, artifactDirectory } = await resolveDirectories(identity);
            const discardIncompleteRecord = (): null => {
                try {
                    deletePersistentArtifactDirectory(artifactDirectory);
                } catch {
                    // A failed deletion remains outside every successful lookup
                    // path and is retried by the incumbent cache cleanup flow.
                    options.onCleanupDiagnostic?.('plugin_ui_artifact_cache_delete_failed');
                }
                return null;
            };
            try {
                const manifestFile = new FileSystem.File(artifactDirectory, PERSISTENT_ARTIFACT_MANIFEST);
                if (!manifestFile.exists) return discardIncompleteRecord();
                const manifest = decodePersistentManifest(await manifestFile.bytes());
                if (!manifest || manifest.identityKey !== derivePluginUiPersistentArtifactKey(identity)) {
                    return discardIncompleteRecord();
                }
                const files: PluginUiPersistentArtifactFile[] = [];
                for (const declared of manifest.files) {
                    const file = new FileSystem.File(artifactDirectory, declared.storedName);
                    if (!file.exists || file.size !== declared.byteSize) return discardIncompleteRecord();
                    const bytes = await file.bytes();
                    if (bytes.byteLength !== declared.byteSize) return discardIncompleteRecord();
                    files.push(Object.freeze({
                        relativePath: declared.relativePath,
                        digest: declared.digest,
                        byteSize: declared.byteSize,
                        bytes,
                    }));
                }
                const entryPath = manifest.entryRelativePath ?? '__entry__';
                const entry = files.find((file) => file.relativePath === entryPath);
                if (!entry) return discardIncompleteRecord();
                return Object.freeze({
                    persistentIdentity: identity,
                    bytes: entry.bytes,
                    ...(manifest.entryRelativePath ? { entryRelativePath: manifest.entryRelativePath } : {}),
                    ...(manifest.entryRelativePath ? { files: Object.freeze(files) } : {}),
                });
            } catch {
                return discardIncompleteRecord();
            }
        },
        write: async (record) => {
            const { FileSystem, accountDirectory, artifactDirectory } = await resolveDirectories(
                record.persistentIdentity,
            );
            accountDirectory.create({ intermediates: true, idempotent: true });
            artifactDirectory.create({ intermediates: true, idempotent: true });
            const manifestFile = new FileSystem.File(artifactDirectory, PERSISTENT_ARTIFACT_MANIFEST);
            if (manifestFile.exists) {
                if (!manifestFile.delete) throw new Error('plugin_ui_artifact_cache_commit_marker_delete_unavailable');
                manifestFile.delete();
            }
            const files = readPersistentRecordFiles(record);
            const manifestFiles: PersistentArtifactManifestV1['files'][number][] = [];
            for (const file of files) {
                const storedName = persistentStoredFileName(file.relativePath);
                const stored = new FileSystem.File(artifactDirectory, storedName);
                stored.write(file.bytes, { append: false });
                manifestFiles.push(Object.freeze({
                    relativePath: file.relativePath,
                    digest: file.digest,
                    byteSize: file.byteSize,
                    storedName,
                }));
            }
            const manifest: PersistentArtifactManifestV1 = Object.freeze({
                v: 1,
                identityKey: derivePluginUiPersistentArtifactKey(record.persistentIdentity),
                ...(record.entryRelativePath ? { entryRelativePath: record.entryRelativePath } : {}),
                files: Object.freeze(manifestFiles),
            });
            manifestFile.write(new TextEncoder().encode(JSON.stringify(manifest)), { append: false });
        },
        describeNativeResource: async ({ identity, files }) => {
            try {
                const { FileSystem, artifactDirectory } = await resolveDirectories(identity);
                const manifestFile = new FileSystem.File(artifactDirectory, PERSISTENT_ARTIFACT_MANIFEST);
                if (!manifestFile.exists) return null;
                const manifest = decodePersistentManifest(await manifestFile.bytes());
                if (
                    !manifest
                    || manifest.identityKey !== derivePluginUiPersistentArtifactKey(identity)
                    || manifest.files.length !== files.length
                ) return null;
                const declaredByRelativePath = new Map(manifest.files.map((file) => [file.relativePath, file]));
                if (
                    declaredByRelativePath.size !== manifest.files.length
                    || new Set(manifest.files.map((file) => file.storedName)).size !== manifest.files.length
                    || new Set(files.map((file) => file.relativePath)).size !== files.length
                ) return null;
                const resources: PluginUiPersistentArtifactNativeStoredResource[] = [];
                for (const requested of files) {
                    const declared = declaredByRelativePath.get(requested.relativePath);
                    if (
                        !declared
                        || declared.digest !== requested.digest
                        || declared.byteSize !== requested.byteSize
                        || !PERSISTENT_STORED_FILE_NAME_PATTERN.test(declared.storedName)
                        || declared.storedName !== persistentStoredFileName(declared.relativePath)
                    ) return null;
                    const stored = new FileSystem.File(artifactDirectory, declared.storedName);
                    if (!stored.exists || stored.size !== declared.byteSize) return null;
                    const bytes = await stored.bytes();
                    if (
                        bytes.byteLength !== declared.byteSize
                        || computePluginUiArtifactSha256DigestV1(bytes) !== declared.digest
                    ) return null;
                    resources.push(Object.freeze({
                        storedFileName: declared.storedName,
                        digest: declared.digest,
                        byteSize: declared.byteSize,
                    }));
                }
                return Object.freeze({
                    locator: Object.freeze({
                        namespace: PERSISTENT_ARTIFACT_DIRECTORY,
                        accountKeyHash: resolvePersistentAccountDirectoryName(identity),
                        artifactKeyHash: resolvePersistentArtifactDirectoryName(identity),
                    }),
                    resources: Object.freeze(resources),
                });
            } catch {
                return null;
            }
        },
        remove: async (identity) => {
            try {
                const { artifactDirectory } = await resolveDirectories(identity);
                deletePersistentArtifactDirectory(artifactDirectory);
            } catch {
                options.onCleanupDiagnostic?.('plugin_ui_artifact_cache_delete_failed');
                throw new Error('plugin_ui_artifact_cache_delete_failed');
            }
        },
        removeAccount: async (scope) => {
            try {
                const FileSystem = await resolveExpoFileSystem(options);
                const cacheDirectory = resolveCacheDirectory(FileSystem);
                const accountDirectory = createPersistentAccountDirectory(FileSystem, cacheDirectory, scope);
                if (accountDirectory.exists === false) return;
                if (!accountDirectory.delete) throw new Error('plugin_ui_artifact_account_cache_delete_unavailable');
                accountDirectory.delete();
            } catch {
                options.onCleanupDiagnostic?.('plugin_ui_artifact_account_cache_delete_failed');
                throw new Error('plugin_ui_artifact_account_cache_delete_failed');
            }
        },
    });
}

async function fileMatchesExpectedArtifact(input: Readonly<{
    file: ExpoFileSystemFile;
    identity: PluginReactNativeBundleCacheIdentity;
    digest?: PluginUiArtifactDigestV1;
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
                    directory.delete?.();
                } catch {
                    // Best effort: a failed delete for one identity must not block the rest.
                }
            }
        },
    });
}
