import {
    deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1 as derivePluginReactNativeBundleCacheKey,
} from '@happier-dev/protocol';
import {
    isPluginUiHermesBytecodeArtifactV1,
    verifyPluginUiArtifactBytesIntegrityV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    type PluginReactNativeBundleCacheIdentity,
} from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
    type PluginUiPersistentArtifactIdentity,
    type PluginUiPersistentArtifactNativeResourceStore,
    type PluginUiPersistentArtifactRecord,
    type PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type {
    PluginReactNativeArtifactLeaseCacheSink,
    PluginReactNativeArtifactLeasePersistentScope,
} from '@/sync/domains/plugins/availability/reactNativeArtifactLease';
import {
    createPluginArtifactPersistentCustody,
    type PluginArtifactPersistentAccountOperation,
    type PluginArtifactPersistentCustody,
} from '@/sync/domains/plugins/availability/artifactLease';
import {
    createPluginNativeArtifactResourcePersistentStore,
    createPluginNativeArtifactResourceRegistry,
    type PluginNativeArtifactPersistentStore,
    type PluginNativeArtifactResourceRegistrar,
    type PluginNativeArtifactResourceRegistry,
} from '@/sync/domains/plugins/availability/nativeArtifactResource';
import { createExpoPluginNativeArtifactResourceRegistrar } from '@/sync/domains/plugins/availability/nativeArtifactResourceRegistrar';
import { createTauriPluginNativeArtifactResourceRegistrar } from '@/sync/domains/plugins/availability/nativeArtifactResourceRegistrar.tauri';
import { createBrowserPluginUiPersistentArtifactStore } from '@/sync/domains/plugins/ui/artifactByteCache.browser';
import { createTauriPluginUiPersistentArtifactStore } from '@/sync/domains/plugins/ui/artifactByteCache.tauri';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import {
    createReactNativeInstalledArtifactDiskGc,
    createReactNativePersistentArtifactStore,
    resolveMaterializedArtifactDirectoryName,
    type ReactNativeInstalledArtifactDiskGc,
} from './artifactFileMaterializer';

export type PluginReactNativeBundleArtifactFormat = 'plainJs' | 'hermesBytecode';

export type PluginReactNativeCachedArtifactFile = Readonly<{
    relativePath: string;
    digest: PluginUiArtifactDigestV1;
    byteSize: number;
    bytes: Uint8Array;
}>;

export type PluginReactNativeCachedArtifact = Readonly<{
    identity: PluginReactNativeBundleCacheIdentity;
    cacheKey: string;
    bytes: Uint8Array;
    format: PluginReactNativeBundleArtifactFormat;
    entryRelativePath?: string;
    files?: readonly PluginReactNativeCachedArtifactFile[];
}>;

export type PluginReactNativePersistentArtifactIdentity = PluginUiPersistentArtifactIdentity
    & Readonly<{ tier: 'reactNative' }>;
export type PluginReactNativePersistentArtifactRecord = PluginUiPersistentArtifactRecord
    & Readonly<{
        persistentIdentity: PluginReactNativePersistentArtifactIdentity;
        files: readonly PluginReactNativeCachedArtifactFile[];
    }>;
export type PluginReactNativePersistentArtifactStore = Readonly<{
    read: (
        identity: PluginReactNativePersistentArtifactIdentity,
    ) => Promise<PluginReactNativePersistentArtifactRecord | null>;
    write: (record: PluginReactNativePersistentArtifactRecord) => Promise<void>;
    /** Exact removal is tier-agnostic; cache read/write ownership stays RN-only. */
    remove: (identity: PluginUiPersistentArtifactIdentity) => Promise<void>;
    removeAccount: (scope: ServerAccountScope) => Promise<void>;
}>;

function isPluginReactNativePersistentArtifactIdentity(
    identity: PluginUiPersistentArtifactIdentity,
): identity is PluginReactNativePersistentArtifactIdentity {
    return identity.tier === 'reactNative';
}

function isPluginReactNativePersistentArtifactRecord(
    record: PluginUiPersistentArtifactRecord,
): record is PluginReactNativePersistentArtifactRecord {
    return isPluginReactNativePersistentArtifactIdentity(record.persistentIdentity);
}

export function derivePluginReactNativePersistentArtifactKey(
    identity: PluginReactNativePersistentArtifactIdentity,
): string {
    return derivePluginUiPersistentArtifactKey(identity);
}

export type PluginReactNativeBundleCachePutResult =
    | Readonly<{ ok: true; cacheKey: string }>
    | Readonly<{
        ok: false;
        code: 'artifact_cache_write_invalidated' | 'hermes_bytecode_unsupported';
        diagnostics: readonly string[];
    }>;

type PluginReactNativeBundleCacheWriteFence = Readonly<{
    cacheKey: string;
}>;

/**
 * One in-process Account cache operation. `isCurrent` keeps the caller's
 * captured lifetime and the cache generation together; `release` only drains
 * physical work and deliberately does not make an already-admitted lease
 * currentness forget its captured generation.
 */
export type PluginReactNativePersistentAccountOperation = PluginArtifactPersistentAccountOperation;

export type PluginReactNativeBundleCache = Readonly<{
    captureWriteFence: (
        identity: PluginReactNativeBundleCacheIdentity,
    ) => PluginReactNativeBundleCacheWriteFence;
    putInstalledArtifact: (entry: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        bytes: Uint8Array;
        format: PluginReactNativeBundleArtifactFormat;
        accountScope?: ServerAccountScope;
        entryRelativePath?: string;
        files?: readonly PluginReactNativeCachedArtifactFile[];
    }>, writeFence?: PluginReactNativeBundleCacheWriteFence) => PluginReactNativeBundleCachePutResult;
    readInstalledArtifact: (identity: PluginReactNativeBundleCacheIdentity) => PluginReactNativeCachedArtifact | null;
    readPersistentArtifact: (
        identity: PluginReactNativePersistentArtifactIdentity,
    ) => Promise<PluginReactNativePersistentArtifactRecord | null>;
    writePersistentArtifact: (
        record: PluginReactNativePersistentArtifactRecord,
    ) => Promise<boolean>;
    removePersistentArtifact: (
        identity: PluginUiPersistentArtifactIdentity,
        /** Existing caller currentness composed with the cache's Account generation. */
        isCurrent?: () => boolean,
    ) => Promise<void>;
    removePersistentArtifactsForAccount: (scope: ServerAccountScope) => Promise<void>;
    bindAccountLifetime: (lifetime: Readonly<{
        scope: ServerAccountScope;
        isCurrent: () => boolean;
        onRetire: (cancel: () => void) => Readonly<{ dispose: () => void }>;
    }>) => void;
    isAccountCurrent: (scope: ServerAccountScope) => boolean;
    /** Captures one Account generation and keeps cleanup fenced until it drains. */
    capturePersistentAccountOperation: (input: Readonly<{
        scope: ServerAccountScope;
        isCurrent: () => boolean;
    }>) => PluginReactNativePersistentAccountOperation | null;
    retireAccount: (scope: ServerAccountScope) => Promise<void>;
    /**
     * Reconciles the process-local executable cache with every active scoped
     * projection source. A cache identity remains reusable until its last
     * current source withdraws it.
     */
    reconcileActiveProjectionIdentities: (
        identities: readonly PluginReactNativeBundleCacheIdentity[],
    ) => void;
}>;

function cloneBytes(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(bytes);
}

function cloneCachedArtifactFiles(
    files: readonly PluginReactNativeCachedArtifactFile[],
): readonly PluginReactNativeCachedArtifactFile[] {
    return files.map((file) => Object.freeze({
        relativePath: file.relativePath,
        digest: file.digest,
        byteSize: file.byteSize,
        bytes: cloneBytes(file.bytes),
    }));
}

function clonePersistentArtifactRecord(
    record: PluginReactNativePersistentArtifactRecord,
): PluginReactNativePersistentArtifactRecord {
    return Object.freeze({
        ...record,
        persistentIdentity: Object.freeze({
            ...record.persistentIdentity,
            accountScope: Object.freeze({ ...record.persistentIdentity.accountScope }),
        }),
        bytes: cloneBytes(record.bytes),
        files: cloneCachedArtifactFiles(record.files),
    });
}

function accountScopeKey(scope: ServerAccountScope): string {
    return derivePluginUiPersistentArtifactAccountKey(scope);
}

function persistentIdentityMatches(
    left: PluginReactNativePersistentArtifactIdentity,
    right: PluginReactNativePersistentArtifactIdentity,
): boolean {
    return derivePluginReactNativePersistentArtifactKey(left)
        === derivePluginReactNativePersistentArtifactKey(right);
}

function persistentRecordHasValidIntegrity(
    record: PluginReactNativePersistentArtifactRecord,
    expected: PluginReactNativePersistentArtifactIdentity,
): boolean {
    if (!persistentIdentityMatches(record.persistentIdentity, expected)) return false;
    // The record always carries the Artifact-owned exact file graph, so the
    // declared entry supplies the entry digest. A record whose declared entry
    // is missing from its own graph is invalid, never an entry-only record.
    const declaredEntry = record.files.find((file) => file.relativePath === record.entryRelativePath);
    if (!declaredEntry) return false;
    const entryIntegrity = verifyPluginUiArtifactBytesIntegrityV1({
        bytes: record.bytes,
        integrity: {
            digest: declaredEntry.digest,
            pluginId: expected.pluginId,
            contributionId: expected.contributionId,
            artifactKind: 'reactNativeBundle',
        },
    });
    if (!entryIntegrity.ok) return false;
    if (record.files.some((file) => {
        if (file.bytes.byteLength !== file.byteSize) return true;
        return !verifyPluginUiArtifactBytesIntegrityV1({
            bytes: file.bytes,
            integrity: {
                digest: file.digest,
                pluginId: expected.pluginId,
                contributionId: expected.contributionId,
                artifactKind: 'reactNativeBundle',
            },
        }).ok;
    })) return false;
    return verifyPluginUiArtifactFileSetIntegrityV1({
        files: record.files.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.bytes,
        })),
        integrity: {
            digest: expected.artifactDigest,
            pluginId: expected.pluginId,
            contributionId: expected.contributionId,
            artifactKind: 'reactNativeBundle',
        },
    }).ok;
}

export type CreatePluginReactNativeBundleCacheOptions = Readonly<{
    // The default singleton wires disk GC so removed materialized executable
    // bytes are deleted from disk; tests may inject a fake.
    diskGc?: ReactNativeInstalledArtifactDiskGc;
    persistentStore?: PluginReactNativePersistentArtifactStore;
    /** Existing Artifact-owned custody; RN owns only hot executable bytes. */
    persistentCustody?: PluginArtifactPersistentCustody;
    /** Existing native-token registry callback; it revokes handles without deleting retained bytes. */
    revokeNativeArtifactResourcesForAccount?: (scope: ServerAccountScope) => void;
    onPersistentCacheDiagnostic?: (code: string) => void;
}>;

/**
 * This is a composition of the existing React Native bundle cache with the
 * one Artifact-owned native-token revocation gate. It does not create a
 * second cache: every cache reader/writer continues to flow through
 * `createPluginReactNativeBundleCache`.
 */
export type PluginReactNativeBundleCacheWithNativeArtifactResources = Readonly<{
    cache: PluginReactNativeBundleCache;
    /** The same wrapped persistent store used by the cache and native frames. */
    nativePersistentStore: PluginNativeArtifactPersistentStore;
    registry: PluginNativeArtifactResourceRegistry;
}>;

export type CreatePluginReactNativeBundleCacheWithNativeArtifactResourcesOptions = Readonly<{
    persistentStore: PluginNativeArtifactPersistentStore;
    registry: PluginNativeArtifactResourceRegistry;
    diskGc?: ReactNativeInstalledArtifactDiskGc;
    onPersistentCacheDiagnostic?: (code: string) => void;
}>;

/**
 * Every host tier reaches the React Native bundle cache through this one
 * adaptation, so a caller that already holds a tier-agnostic
 * `PluginUiPersistentArtifactStore` narrows it here rather than re-declaring
 * the RN-only record contract.
 */
export function adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(
    store: PluginUiPersistentArtifactStore,
): PluginReactNativePersistentArtifactStore {
    return Object.freeze({
        read: async (identity) => {
            const record = await store.read(identity);
            return record
                ? Object.freeze({
                    ...record,
                    persistentIdentity: identity,
                    bytes: new Uint8Array(record.bytes),
                    files: Object.freeze(record.files.map((file) => Object.freeze({
                        relativePath: file.relativePath,
                        digest: file.digest,
                        byteSize: file.byteSize,
                        bytes: new Uint8Array(file.bytes),
                    }))),
                })
                : null;
        },
        write: async (record) => {
            await store.write(record);
        },
        remove: async (identity) => {
            await store.remove(identity);
        },
        removeAccount: async (scope) => {
            await store.removeAccount(scope);
        },
    });
}

/**
 * Compose the cache once with the native Artifact wrapper. The returned
 * persistent store is intentionally the wrapper, never the raw filesystem
 * store. Account retirement calls the same registry directly, so retirement,
 * replacement, and cache cleanup cannot bypass native token tombstoning.
 */
export function createPluginReactNativeBundleCacheWithNativeArtifactResources(
    input: CreatePluginReactNativeBundleCacheWithNativeArtifactResourcesOptions,
): PluginReactNativeBundleCacheWithNativeArtifactResources {
    const nativePersistentStore = createPluginNativeArtifactResourcePersistentStore({
        store: input.persistentStore,
        registry: input.registry,
    });
    return Object.freeze({
        cache: createPluginReactNativeBundleCache({
            diskGc: input.diskGc,
            persistentStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(nativePersistentStore),
            revokeNativeArtifactResourcesForAccount: input.registry.revokeAccount,
            onPersistentCacheDiagnostic: input.onPersistentCacheDiagnostic,
        }),
        nativePersistentStore,
        registry: input.registry,
    });
}

/**
 * A scoped view of the one native persistent store. It adds no storage or
 * currentness owner: every operation delegates to the incumbent store while
 * retaining the cache operation generation that admitted it.
 */
export function createPluginReactNativePersistentAccountOperationStore(input: Readonly<{
    store: PluginNativeArtifactPersistentStore;
    operation: PluginReactNativePersistentAccountOperation;
}>): PluginNativeArtifactPersistentStore {
    const isCurrent = () => input.operation.isOpen() && input.operation.isCurrent();
    return Object.freeze({
        read: async (identity) => {
            if (!isCurrent()) return null;
            await input.operation.awaitPendingPersistentArtifactRemoval(identity);
            if (!isCurrent()) return null;
            const record = await input.store.read(identity);
            return isCurrent() ? record : null;
        },
        write: async (record) => {
            if (!isCurrent()) {
                throw new Error('react_native_artifact_persistent_operation_invalidated');
            }
            await input.operation.awaitPendingPersistentArtifactRemoval(record.persistentIdentity);
            if (!isCurrent()) {
                throw new Error('react_native_artifact_persistent_operation_invalidated');
            }
            await input.store.write(record);
            if (!isCurrent()) {
                throw new Error('react_native_artifact_persistent_operation_invalidated');
            }
        },
        remove: async (identity) => {
            if (!areServerAccountScopesEqual(identity.accountScope, input.operation.scope)) return;
            if (!isCurrent()) return;
            await input.operation.removePersistentArtifact(identity);
        },
        removeAccount: async (scope) => {
            if (!isCurrent()) return;
            if (!areServerAccountScopesEqual(scope, input.operation.scope)) return;
            await input.operation.removePersistentArtifactsForAccount();
        },
        describeNativeResource: async (descriptor) => {
            if (!isCurrent()) return null;
            const described = await input.store.describeNativeResource(descriptor);
            return isCurrent() ? described : null;
        },
    });
}

function isCurrentLeaseCacheLifetime(input: Readonly<{
    cache: PluginReactNativeBundleCache;
    lifetime: ActiveServerAccountScopeLifetime;
    scope: ServerAccountScope;
}>): boolean {
    return areServerAccountScopesEqual(input.lifetime.scope, input.scope)
        && input.lifetime.isCurrent()
        && input.cache.isAccountCurrent(input.scope);
}

/**
 * The concrete renderer-cache adapter for the canonical Artifact lease. It
 * captures the incumbent cache write fence only after the Account lifetime and
 * exact scope are current; it never fetches or validates Artifact bytes.
 */
export function createPluginReactNativeArtifactLeaseCacheSink(input: Readonly<{
    cache: PluginReactNativeBundleCache;
    lifetime: ActiveServerAccountScopeLifetime;
}>): PluginReactNativeArtifactLeaseCacheSink {
    input.cache.bindAccountLifetime(input.lifetime);
    return Object.freeze({
        writeVerifiedArtifact: (entry) => {
            if (!isCurrentLeaseCacheLifetime({
                cache: input.cache,
                lifetime: input.lifetime,
                scope: entry.accountScope,
            })) {
                return Object.freeze({
                    ok: false as const,
                    code: 'artifact_cache_write_invalidated' as const,
                    diagnostics: Object.freeze(['react_native_artifact_account_scope_retired']),
                });
            }
            const writeFence = input.cache.captureWriteFence(entry.identity);
            if (!isCurrentLeaseCacheLifetime({
                cache: input.cache,
                lifetime: input.lifetime,
                scope: entry.accountScope,
            })) {
                return Object.freeze({
                    ok: false as const,
                    code: 'artifact_cache_write_invalidated' as const,
                    diagnostics: Object.freeze(['react_native_artifact_account_scope_retired']),
                });
            }
            return input.cache.putInstalledArtifact({
                identity: entry.identity,
                bytes: entry.bytes,
                // Read the format off the verified entry bytes. Asserting
                // `plainJs` here made the cache's Hermes refusal unreachable for
                // every source, including the ones that never touch the daemon.
                format: isPluginUiHermesBytecodeArtifactV1(entry.bytes)
                    ? 'hermesBytecode'
                    : 'plainJs',
                accountScope: entry.accountScope,
                entryRelativePath: entry.entryRelativePath,
                files: entry.files,
            }, writeFence);
        },
    });
}

/**
 * Adapts the existing Account-bound persistent cache to Artifact's generic
 * source interface. This is only a scope/currentness bridge; source order and
 * Artifact identity remain in the lease owner.
 */
export type PluginReactNativeArtifactLeasePersistentScopeSession =
    PluginReactNativeArtifactLeasePersistentScope & Readonly<{
        /** Ends raw persistent-store work while retaining captured lease currentness. */
        release: () => void;
    }>;

export function createPluginReactNativeArtifactLeasePersistentScope(input: Readonly<{
    cache: PluginReactNativeBundleCache;
    lifetime: ActiveServerAccountScopeLifetime;
}>): PluginReactNativeArtifactLeasePersistentScopeSession {
    input.cache.bindAccountLifetime(input.lifetime);
    const operation = input.cache.capturePersistentAccountOperation({
        scope: input.lifetime.scope,
        isCurrent: input.lifetime.isCurrent,
    });
    const isCurrent = () => operation !== null && isCurrentLeaseCacheLifetime({
        cache: input.cache,
        lifetime: input.lifetime,
        scope: input.lifetime.scope,
    }) && operation.isCurrent();
    const canUseStore = () => operation !== null && operation.isOpen() && isCurrent();
    // Source acquisition may finish before its revocable Artifact lease does. A
    // lease that proves its retained bytes cannot satisfy the current digest
    // still needs the Artifact custody owner's exact-entry cleanup while the captured
    // Account lifetime remains current. Availability withdrawal alone does not:
    // it retires reachability, and deletion of a superseded or withdrawn
    // identity belongs to the projection writer that holds both snapshots.
    const canRemovePersistentArtifact = () => operation !== null && isCurrent();
    const store: PluginUiPersistentArtifactStore = Object.freeze({
        read: async (identity) => {
            if (!isPluginReactNativePersistentArtifactIdentity(identity) || !canUseStore()) {
                return null;
            }
            const record = await operation?.readPersistentArtifact(identity) ?? null;
            return canUseStore() ? record : null;
        },
        write: async (record) => {
            if (!isPluginReactNativePersistentArtifactRecord(record) || !canUseStore()) {
                throw new Error('react_native_artifact_persistent_scope_retired');
            }
            const written = await operation?.writePersistentArtifact(record) ?? false;
            if (!written || !canUseStore()) {
                throw new Error('react_native_artifact_persistent_write_invalidated');
            }
        },
        remove: async (identity) => {
            if (!isPluginReactNativePersistentArtifactIdentity(identity) || !canRemovePersistentArtifact()) return;
            await input.cache.removePersistentArtifact(identity, operation?.isCurrent);
        },
        removeAccount: async (scope) => {
            if (!areServerAccountScopesEqual(scope, input.lifetime.scope) || !canUseStore()) return;
            await input.cache.removePersistentArtifactsForAccount(scope);
        },
    });
    return Object.freeze({
        scope: input.lifetime.scope,
        store,
        isCurrent,
        removePersistentArtifact: store.remove,
        release: () => operation?.release(),
    });
}

export function createPluginReactNativeBundleCache(
    options: CreatePluginReactNativeBundleCacheOptions = {},
): PluginReactNativeBundleCache {
    const entries = new Map<string, PluginReactNativeCachedArtifact>();
    const diskGc = options.diskGc;
    const persistentStore = options.persistentStore;
    const diagnosePersistentCache = options.onPersistentCacheDiagnostic;
    const persistentCustody = options.persistentCustody ?? createPluginArtifactPersistentCustody({
        store: persistentStore as unknown as PluginUiPersistentArtifactStore | undefined,
        revokeNativeArtifactResourcesForAccount: options.revokeNativeArtifactResourcesForAccount,
        onDiagnostic: options.onPersistentCacheDiagnostic,
    });
    const hotEntryAccountScopes = new Map<string, string>();
    // This is the existing complete source union, indexed by hot-cache key
    // with the materializer's stable directory identity alongside it. It does
    // not own currentness; the projection reconciler supplies that truth.
    const activeProjectionIdentityDirectoryNames = new Map<string, string>();
    // Before the reconciler observes its first complete source union, the
    // incumbent Artifact path may still be writing bytes for the mount which
    // is about to register that union. Afterwards, this existing set is the
    // sole write-currentness authority for every fenced identity.
    let hasReconciledActiveProjectionSources = false;

    function scheduleDiskEviction(identities: readonly PluginReactNativeBundleCacheIdentity[]): void {
        if (!diskGc || identities.length === 0) {
            return;
        }
        const currentMaterializedDirectoryNames = new Set(
            activeProjectionIdentityDirectoryNames.values(),
        );
        const physicallyEvictableIdentities = identities.filter(
            (identity) => !currentMaterializedDirectoryNames.has(
                resolveMaterializedArtifactDirectoryName(identity),
            ),
        );
        if (physicallyEvictableIdentities.length === 0) {
            return;
        }
        void Promise.resolve(diskGc.evictForIdentities(physicallyEvictableIdentities)).catch(() => {
            diagnosePersistentCache?.('plugin_ui_artifact_executable_delete_failed');
        });
    }

    function reconcileActiveProjectionIdentities(
        identities: readonly PluginReactNativeBundleCacheIdentity[],
    ): void {
        hasReconciledActiveProjectionSources = true;
        const nextIdentityDirectoryNames = new Map<string, string>();
        for (const identity of identities) {
            nextIdentityDirectoryNames.set(
                derivePluginReactNativeBundleCacheKey(identity),
                resolveMaterializedArtifactDirectoryName(identity),
            );
        }
        const sourcesChanged = !(
            nextIdentityDirectoryNames.size === activeProjectionIdentityDirectoryNames.size
            && [...nextIdentityDirectoryNames].every(([key, directoryName]) => (
                activeProjectionIdentityDirectoryNames.get(key) === directoryName
            ))
        );
        const hasUnownedEntry = [...entries.keys()].some(
            (key) => !nextIdentityDirectoryNames.has(key),
        );
        if (!sourcesChanged && !hasUnownedEntry) {
            return;
        }

        if (sourcesChanged) {
            activeProjectionIdentityDirectoryNames.clear();
            for (const [key, directoryName] of nextIdentityDirectoryNames) {
                activeProjectionIdentityDirectoryNames.set(key, directoryName);
            }
        }

        const evictedIdentities: PluginReactNativeBundleCacheIdentity[] = [];
        for (const [key, entry] of entries.entries()) {
            if (!activeProjectionIdentityDirectoryNames.has(key)) {
                evictedIdentities.push(entry.identity);
                entries.delete(key);
                hotEntryAccountScopes.delete(key);
            }
        }
        scheduleDiskEviction(evictedIdentities);
    }

    async function retireAccount(scope: ServerAccountScope): Promise<void> {
        await persistentCustody.retireAccount(scope);
        const key = accountScopeKey(scope);
        const evictedIdentities: PluginReactNativeBundleCacheIdentity[] = [];
        for (const [cacheKey, entryScope] of hotEntryAccountScopes.entries()) {
            if (entryScope !== key) continue;
            const entry = entries.get(cacheKey);
            if (entry) evictedIdentities.push(entry.identity);
            entries.delete(cacheKey);
            hotEntryAccountScopes.delete(cacheKey);
        }
        scheduleDiskEviction(evictedIdentities);
    }

    /**
     * The one exact-entry physical deletion path. Readers, scoped native
     * adapters, and Availability cleanup all enqueue here so a later same-key
     * read or write cannot re-adopt bytes that this deletion will erase.
     */
    async function removePersistentArtifact(
        identity: PluginUiPersistentArtifactIdentity,
        isCurrent: () => boolean = () => true,
    ): Promise<void> {
        await persistentCustody.removePersistentArtifact(identity, isCurrent);
    }

    return Object.freeze({
        captureWriteFence: (identity) => {
            const cacheKey = derivePluginReactNativeBundleCacheKey(identity);
            return Object.freeze({ cacheKey });
        },
        putInstalledArtifact: (entry, writeFence) => {
            if (entry.format === 'hermesBytecode') {
                return Object.freeze({
                    ok: false,
                    code: 'hermes_bytecode_unsupported',
                    diagnostics: Object.freeze(['hermes_bytecode_unsupported']),
                });
            }
            const cacheKey = derivePluginReactNativeBundleCacheKey(entry.identity);
            if (writeFence) {
                const invalidated = (
                    writeFence.cacheKey !== cacheKey
                    || (
                        hasReconciledActiveProjectionSources
                        && !activeProjectionIdentityDirectoryNames.has(cacheKey)
                    )
                );
                if (invalidated) {
                    return Object.freeze({
                        ok: false,
                        code: 'artifact_cache_write_invalidated',
                        diagnostics: Object.freeze(['react_native_artifact_cache_write_invalidated']),
                    });
                }
            }
            entries.set(cacheKey, Object.freeze({
                identity: entry.identity,
                cacheKey,
                bytes: cloneBytes(entry.bytes),
                format: entry.format,
                ...(entry.entryRelativePath ? { entryRelativePath: entry.entryRelativePath } : {}),
                ...(entry.files ? { files: cloneCachedArtifactFiles(entry.files) } : {}),
            }));
            if (entry.accountScope) {
                hotEntryAccountScopes.set(cacheKey, accountScopeKey(entry.accountScope));
            } else {
                hotEntryAccountScopes.delete(cacheKey);
            }
            return Object.freeze({ ok: true, cacheKey });
        },
        readInstalledArtifact: (identity) => {
            const entry = entries.get(derivePluginReactNativeBundleCacheKey(identity));
            return entry
                ? Object.freeze({
                    ...entry,
                    bytes: cloneBytes(entry.bytes),
                    ...(entry.files ? { files: cloneCachedArtifactFiles(entry.files) } : {}),
                })
                : null;
        },
        readPersistentArtifact: async (identity) => {
            const record = await persistentCustody.readPersistentArtifact(identity);
            if (!record || !persistentRecordHasValidIntegrity(record as PluginReactNativePersistentArtifactRecord, identity)) {
                if (record) await persistentCustody.removePersistentArtifact(identity);
                return null;
            }
            return clonePersistentArtifactRecord(record as PluginReactNativePersistentArtifactRecord);
        },
        writePersistentArtifact: async (record) => {
            if (!persistentRecordHasValidIntegrity(record, record.persistentIdentity)) return false;
            return persistentCustody.writePersistentArtifact(record);
        },
        removePersistentArtifact: (identity, isCurrent) => persistentCustody.removePersistentArtifact(identity, isCurrent),
        removePersistentArtifactsForAccount: async (scope) => {
            await persistentCustody.removePersistentArtifactsForAccount(scope);
        },
        bindAccountLifetime: (lifetime) => {
            persistentCustody.bindAccountLifetime(lifetime);
        },
        isAccountCurrent: persistentCustody.isAccountCurrent,
        capturePersistentAccountOperation: persistentCustody.capturePersistentAccountOperation,
        retireAccount,
        reconcileActiveProjectionIdentities,
    });
}

type DefaultPersistentArtifactStore = Readonly<{
    reactNativeStore: PluginReactNativePersistentArtifactStore;
    /** Present only where the app-private native Artifact filesystem exists. */
    nativeStore: PluginUiPersistentArtifactNativeResourceStore | null;
    nativeResourceRegistrar: PluginNativeArtifactResourceRegistrar | null;
}>;

function createDefaultPersistentArtifactStore(): DefaultPersistentArtifactStore {
    if (isDesktopHost()) {
        const nativeStore = createTauriPluginUiPersistentArtifactStore();
        return Object.freeze({
            reactNativeStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(nativeStore),
            nativeStore,
            nativeResourceRegistrar: createTauriPluginNativeArtifactResourceRegistrar(),
        });
    }
    if (typeof globalThis.caches !== 'undefined') {
        const browserStore = createBrowserPluginUiPersistentArtifactStore(globalThis.caches);
        return Object.freeze({
            reactNativeStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(browserStore),
            nativeStore: null,
            nativeResourceRegistrar: null,
        });
    }
    const nativeStore = createReactNativePersistentArtifactStore();
    return Object.freeze({
        reactNativeStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(nativeStore),
        nativeStore,
        nativeResourceRegistrar: createExpoPluginNativeArtifactResourceRegistrar(),
    });
}

export type InstalledPluginNativeArtifactResources = Readonly<{
    /** The native-token-gated store; the raw filesystem store is never exported. */
    nativePersistentStore: PluginNativeArtifactPersistentStore;
    registry: PluginNativeArtifactResourceRegistry;
}>;

const defaultPersistentArtifactStore = createDefaultPersistentArtifactStore();
const installedDiskGc = createReactNativeInstalledArtifactDiskGc();
const nativeStore = defaultPersistentArtifactStore.nativeStore;
const nativeResourceRegistrar = defaultPersistentArtifactStore.nativeResourceRegistrar;
const installedNativeArtifactComposition = nativeStore && nativeResourceRegistrar
    ? createPluginReactNativeBundleCacheWithNativeArtifactResources({
        diskGc: installedDiskGc,
        persistentStore: nativeStore,
        registry: createPluginNativeArtifactResourceRegistry({
            registrar: nativeResourceRegistrar,
        }),
    })
    : null;
const installedNativeArtifactResources: InstalledPluginNativeArtifactResources | null = installedNativeArtifactComposition
    ? Object.freeze({
        nativePersistentStore: installedNativeArtifactComposition.nativePersistentStore,
        registry: installedNativeArtifactComposition.registry,
    })
    : null;
const installedPluginReactNativeBundleCache = installedNativeArtifactComposition?.cache
    ?? createPluginReactNativeBundleCache({
        diskGc: installedDiskGc,
        persistentStore: defaultPersistentArtifactStore.reactNativeStore,
    });

export function getInstalledPluginReactNativeBundleCache(): PluginReactNativeBundleCache {
    return installedPluginReactNativeBundleCache;
}

/**
 * Hosted-web consumers receive only the already-wrapped persistent store and
 * Artifact registry. A null result on web prevents an alternate byte path.
 */
export function getInstalledPluginNativeArtifactResources(): InstalledPluginNativeArtifactResources | null {
    return installedNativeArtifactResources;
}

export {
    derivePluginReactNativeBundleCacheKey,
    type PluginReactNativeBundleCacheIdentity,
};
