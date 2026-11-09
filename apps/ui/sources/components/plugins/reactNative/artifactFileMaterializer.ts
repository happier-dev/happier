import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
    PluginUiArtifactDigestV1Schema,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginUiPersistentArtifactAccessClock,
    createPluginUiPersistentArtifactOperationQueue,
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
    planPluginUiPersistentArtifactRetention,
    readPluginUiPersistentArtifactAccessStamp,
    PLUGIN_UI_PERSISTENT_ARTIFACT_NATIVE_BYTE_BUDGET,
    type PluginUiPersistentArtifactFile,
    type PluginUiPersistentArtifactIdentity,
    type PluginUiPersistentArtifactNativeStoredResource,
    type PluginUiPersistentArtifactNativeResourceStore,
    type PluginUiPersistentArtifactRetainedRecord,
} from '@/sync/domains/plugins/ui/artifactByteCache';

const PERSISTENT_ARTIFACT_DIRECTORY = 'happier-plugin-ui-artifacts-v1';
const PERSISTENT_ARTIFACT_MANIFEST = 'record.v1.json';
const PERSISTENT_STORED_FILE_NAME_PATTERN = /^[a-f0-9]{64}\.bin$/u;

type ExpoFileSystemDirectory = Readonly<{
    uri: string;
    exists?: boolean;
    create: (options?: { intermediates?: boolean; idempotent?: boolean }) => void;
    list?: () => readonly ExpoFileSystemDirectory[];
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

export type ReactNativeInstalledArtifactFileMaterializerOptions = Readonly<{
    fileSystem?: ExpoFileSystemModule;
}>;

function sha256Hex(value: string): string {
    return bytesToHex(sha256(utf8ToBytes(value)));
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

type PersistentArtifactManifestV1 = Readonly<{
    v: 1;
    identityKey: string;
    entryRelativePath: string;
    /** Byte-LRU ordering only; it is never compared against the current time. */
    lastAccessedAt: number;
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

function retirePersistentArtifactCommitMarker(
    FileSystem: ExpoFileSystemModule,
    artifactDirectory: ExpoFileSystemDirectory,
): void {
    const manifestFile = new FileSystem.File(artifactDirectory, PERSISTENT_ARTIFACT_MANIFEST);
    if (!manifestFile.exists) return;
    if (!manifestFile.delete) {
        throw new Error('plugin_ui_artifact_cache_commit_marker_delete_unavailable');
    }
    manifestFile.delete();
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
            || typeof value.entryRelativePath !== 'string'
            || value.entryRelativePath.length === 0
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
                || !PERSISTENT_STORED_FILE_NAME_PATTERN.test(file.storedName)
                || file.storedName !== persistentStoredFileName(file.relativePath)
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
            entryRelativePath: value.entryRelativePath,
            lastAccessedAt: readPluginUiPersistentArtifactAccessStamp(value.lastAccessedAt),
            files: Object.freeze(files),
        });
    } catch {
        return null;
    }
}

function encodePersistentManifest(manifest: PersistentArtifactManifestV1): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(manifest));
}

/**
 * Enumerate every committed record across every Account and reclaim anything
 * that is not one. This is the only place the native owner learns its total, so
 * partial-record cleanup and budget accounting stay one pass, not two.
 */
async function scanRetainedPersistentRecords(input: Readonly<{
    FileSystem: ExpoFileSystemModule;
    cacheDirectory: ExpoFileSystemDirectory;
    onCleanupDiagnostic?: (code: string) => void;
}>): Promise<readonly Readonly<{
    record: PluginUiPersistentArtifactRetainedRecord;
    directory: ExpoFileSystemDirectory;
    identityKey: string;
}>[]> {
    const root = new input.FileSystem.Directory(input.cacheDirectory, PERSISTENT_ARTIFACT_DIRECTORY);
    // Listing is how this owner sees its own total; without it there is nothing
    // to account for and nothing to reclaim.
    if (root.exists === false || !root.list) return [];
    const retained: Array<Readonly<{
        record: PluginUiPersistentArtifactRetainedRecord;
        directory: ExpoFileSystemDirectory;
        identityKey: string;
    }>> = [];
    const reclaim = (directory: ExpoFileSystemDirectory) => {
        try {
            deletePersistentArtifactDirectory(directory);
        } catch {
            input.onCleanupDiagnostic?.('plugin_ui_artifact_cache_delete_failed');
        }
    };
    for (const accountDirectory of root.list()) {
        if (!accountDirectory.list) continue;
        for (const artifactDirectory of accountDirectory.list()) {
            const manifestFile = new input.FileSystem.File(artifactDirectory, PERSISTENT_ARTIFACT_MANIFEST);
            if (!manifestFile.exists) {
                reclaim(artifactDirectory);
                continue;
            }
            const manifestBytes = await manifestFile.bytes().catch(() => null);
            const manifest = manifestBytes ? decodePersistentManifest(manifestBytes) : null;
            if (!manifest || !manifestBytes) {
                reclaim(artifactDirectory);
                continue;
            }
            retained.push(Object.freeze({
                directory: artifactDirectory,
                identityKey: manifest.identityKey,
                record: Object.freeze({
                    locationKey: persistentRecordLocationKey(artifactDirectory),
                    chargedBytes: manifest.files.reduce((total, file) => total + file.byteSize, 0)
                        + manifestBytes.byteLength,
                    lastAccessedAt: manifest.lastAccessedAt,
                }),
            }));
        }
    }
    return Object.freeze(retained);
}

/** Trailing separators differ between listed and constructed directories. */
function persistentRecordLocationKey(directory: ExpoFileSystemDirectory): string {
    return directory.uri.replace(/\/+$/u, '');
}

export type ReactNativePersistentArtifactStoreOptions = ReactNativeInstalledArtifactFileMaterializerOptions
    & Readonly<{
        onCleanupDiagnostic?: (code: string) => void;
        /**
         * The Artifact-owned budget this physical owner enforces. It exists so
         * the owner tests can prove the exact/+1 boundary without allocating
         * 640 MiB; the shipped value is always the canonical constant.
         */
        budgetBytes?: number;
        /** Existing native token state projected into the physical LRU owner. */
        isPersistentArtifactIdentityInUse?: (identityKey: string) => boolean;
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
    const budgetBytes = options.budgetBytes ?? PLUGIN_UI_PERSISTENT_ARTIFACT_NATIVE_BYTE_BUDGET;
    const nextAccessStamp = createPluginUiPersistentArtifactAccessClock();
    const resolveDirectories = async (identity: PluginUiPersistentArtifactIdentity) => {
        const FileSystem = await resolveExpoFileSystem(options);
        const cacheDirectory = resolveCacheDirectory(FileSystem);
        return {
            FileSystem,
            cacheDirectory,
            accountDirectory: createPersistentAccountDirectory(FileSystem, cacheDirectory, identity.accountScope),
            artifactDirectory: createPersistentArtifactDirectory(FileSystem, cacheDirectory, identity),
        };
    };
    const refreshAccessOrder = (
        FileSystem: ExpoFileSystemModule,
        artifactDirectory: ExpoFileSystemDirectory,
        manifest: PersistentArtifactManifestV1,
    ): void => {
        // Ordering only: a failed refresh leaves the committed record intact and
        // costs at most one suboptimal eviction choice.
        try {
            new FileSystem.File(artifactDirectory, PERSISTENT_ARTIFACT_MANIFEST).write(
                encodePersistentManifest(Object.freeze({ ...manifest, lastAccessedAt: nextAccessStamp() })),
                { append: false },
            );
        } catch {
            options.onCleanupDiagnostic?.('plugin_ui_artifact_cache_access_refresh_failed');
        }
    };

    const store: PluginUiPersistentArtifactNativeResourceStore = Object.freeze({
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
                const entry = files.find((file) => file.relativePath === manifest.entryRelativePath);
                if (!entry) return discardIncompleteRecord();
                refreshAccessOrder(FileSystem, artifactDirectory, manifest);
                return Object.freeze({
                    persistentIdentity: identity,
                    bytes: entry.bytes,
                    entryRelativePath: manifest.entryRelativePath,
                    files: Object.freeze(files),
                });
            } catch {
                return discardIncompleteRecord();
            }
        },
        write: async (record) => {
            const { FileSystem, cacheDirectory, accountDirectory, artifactDirectory } = await resolveDirectories(
                record.persistentIdentity,
            );
            const files = record.files;
            const manifestFiles: PersistentArtifactManifestV1['files'][number][] = files.map((file) => Object.freeze({
                relativePath: file.relativePath,
                digest: file.digest,
                byteSize: file.byteSize,
                storedName: persistentStoredFileName(file.relativePath),
            }));
            const manifest: PersistentArtifactManifestV1 = Object.freeze({
                v: 1,
                identityKey: derivePluginUiPersistentArtifactKey(record.persistentIdentity),
                entryRelativePath: record.entryRelativePath,
                lastAccessedAt: nextAccessStamp(),
                files: Object.freeze(manifestFiles),
            });
            const manifestBytes = encodePersistentManifest(manifest);
            const retained = await scanRetainedPersistentRecords({
                FileSystem,
                cacheDirectory,
                ...(options.onCleanupDiagnostic ? { onCleanupDiagnostic: options.onCleanupDiagnostic } : {}),
            });
            const incomingLocationKey = persistentRecordLocationKey(artifactDirectory);
            const protectedLocationKeys = new Set(retained.flatMap((entry) => {
                if (!options.isPersistentArtifactIdentityInUse) return [];
                try {
                    return options.isPersistentArtifactIdentityInUse(entry.identityKey)
                        ? [entry.record.locationKey]
                        : [];
                } catch {
                    // An unavailable token projection must fail closed for the
                    // mounted bytes it might represent.
                    return [entry.record.locationKey];
                }
            }));
            const plan = planPluginUiPersistentArtifactRetention({
                budgetBytes,
                incomingLocationKey,
                incomingChargedBytes: files.reduce((total, file) => total + file.byteSize, 0)
                    + manifestBytes.byteLength,
                retained: retained.map((entry) => entry.record),
                protectedLocationKeys,
            });
            const directoriesByLocationKey = new Map(retained.map(
                (entry) => [entry.record.locationKey, entry.directory] as const,
            ));
            for (const locationKey of plan.evictLocationKeys) {
                const directory = directoriesByLocationKey.get(locationKey);
                if (!directory) continue;
                try {
                    // Lookup authority is the manifest: retire it before the
                    // physical reclamation, exactly as `remove` does.
                    retirePersistentArtifactCommitMarker(FileSystem, directory);
                    deletePersistentArtifactDirectory(directory);
                } catch {
                    options.onCleanupDiagnostic?.('plugin_ui_artifact_cache_delete_failed');
                    // Do not commit more bytes after a required eviction failed:
                    // capacity fallback is not an I/O-error fallback.
                    throw new Error('plugin_ui_artifact_cache_delete_failed');
                }
            }
            // A verified artifact larger than the whole budget still served the
            // current load; it is simply never adopted into persistent storage.
            if (!plan.persist) {
                return plan.reason === 'oversize' ? 'notPersistedOversize' : 'notPersistedCapacity';
            }
            accountDirectory.create({ intermediates: true, idempotent: true });
            artifactDirectory.create({ intermediates: true, idempotent: true });
            const manifestFile = new FileSystem.File(artifactDirectory, PERSISTENT_ARTIFACT_MANIFEST);
            if (manifestFile.exists) {
                if (!manifestFile.delete) throw new Error('plugin_ui_artifact_cache_commit_marker_delete_unavailable');
                manifestFile.delete();
            }
            for (const file of files) {
                new FileSystem.File(artifactDirectory, persistentStoredFileName(file.relativePath))
                    .write(file.bytes, { append: false });
            }
            manifestFile.write(manifestBytes, { append: false });
            return 'persisted';
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
                    resources.push(Object.freeze({
                        storedFileName: declared.storedName,
                        digest: declared.digest,
                        byteSize: declared.byteSize,
                    }));
                }
                // Native serving is a successful access of these exact bytes, so
                // it refreshes byte-LRU ordering just like a direct read.
                refreshAccessOrder(FileSystem, artifactDirectory, manifest);
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
                const { FileSystem, artifactDirectory } = await resolveDirectories(identity);
                // Lookup authority is the manifest, not directory existence.
                // Retire it durably before best-effort physical reclamation so
                // a restart cannot resurrect bytes left by a failed delete.
                retirePersistentArtifactCommitMarker(FileSystem, artifactDirectory);
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
                if (!accountDirectory.list) {
                    throw new Error('plugin_ui_artifact_account_cache_list_unavailable');
                }
                for (const artifactDirectory of accountDirectory.list()) {
                    retirePersistentArtifactCommitMarker(FileSystem, artifactDirectory);
                }
                if (!accountDirectory.delete) throw new Error('plugin_ui_artifact_account_cache_delete_unavailable');
                accountDirectory.delete();
            } catch {
                options.onCleanupDiagnostic?.('plugin_ui_artifact_account_cache_delete_failed');
                throw new Error('plugin_ui_artifact_account_cache_delete_failed');
            }
        },
    });
    const runExclusive = createPluginUiPersistentArtifactOperationQueue();
    return Object.freeze({
        read: (identity) => runExclusive(() => store.read(identity)),
        write: (record) => runExclusive(() => store.write(record)),
        remove: (identity) => runExclusive(() => store.remove(identity)),
        removeAccount: (scope) => runExclusive(() => store.removeAccount(scope)),
        describeNativeResource: (input) => runExclusive(() => store.describeNativeResource(input)),
    });
}

function assertFileUri(uri: string): void {
    if (!uri.startsWith('file://')) {
        throw new Error('React Native installed artifact materializer must materialize to a file:// URL');
    }
}
