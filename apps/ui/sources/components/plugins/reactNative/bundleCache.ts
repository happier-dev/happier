import {
    isPluginUiHermesBytecodeArtifactV1,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    computePluginUiArtifactFileSetSha256Digest,
    computePluginUiArtifactSha256Digest,
} from '@/sync/domains/plugins/ui/artifactIntegrity';

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
    type PluginUiPersistentArtifactWriteDisposition,
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
import { createReactNativePersistentArtifactStore } from './artifactFileMaterializer';

/** Bytes are content-addressed inside the existing Account privacy partition. */
export function derivePluginReactNativeBundleCacheKey(
    identity: PluginReactNativeBundleCacheIdentity | Pick<PluginReactNativeBundleCacheIdentity, 'artifactDigest'>,
): string {
    return identity.artifactDigest;
}

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

export type PluginReactNativePersistentArtifactIdentity = PluginUiPersistentArtifactIdentity;
export type PluginReactNativePersistentArtifactRecord = PluginUiPersistentArtifactRecord & Readonly<{
    files: readonly PluginReactNativeCachedArtifactFile[];
}>;
export type PluginReactNativePersistentArtifactStore = Readonly<{
    read: (
        identity: PluginReactNativePersistentArtifactIdentity,
    ) => Promise<PluginReactNativePersistentArtifactRecord | null>;
    write: (
        record: PluginReactNativePersistentArtifactRecord,
    ) => Promise<PluginUiPersistentArtifactWriteDisposition>;
    /** Exact removal is tier-agnostic; cache read/write ownership stays RN-only. */
    remove: (identity: PluginUiPersistentArtifactIdentity) => Promise<void>;
    removeAccount: (scope: ServerAccountScope) => Promise<void>;
}>;

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
    readInstalledArtifact: (identity: PluginReactNativeBundleCacheIdentity | Pick<PluginReactNativeBundleCacheIdentity, 'artifactDigest'>, accountScope?: ServerAccountScope) => PluginReactNativeCachedArtifact | null;
    /**
     * The installed entry's compiled program, compiled from its retained bytes on
     * first use and released with them. Null when the digest is not installed.
     */
    readInstalledProgram: <TProgram>(
        identity: Pick<PluginReactNativeBundleCacheIdentity, 'artifactDigest'>,
        compile: (bytes: Uint8Array) => TProgram,
    ) => TProgram | null;
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
     * Reconciles the process-local executable cache with the projection owner's
     * active and retained identities. A cache identity remains reusable until
     * that owner releases it (Artifact changed, plugin disabled, Account retired).
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

function isSameInstalledArtifact(
    installed: PluginReactNativeCachedArtifact,
    entry: Readonly<{
        identity: PluginReactNativeBundleCacheIdentity;
        format: PluginReactNativeBundleArtifactFormat;
        entryRelativePath?: string;
        files?: readonly PluginReactNativeCachedArtifactFile[];
    }>,
): boolean {
    const a = installed.identity;
    const b = entry.identity;
    return a.pluginId === b.pluginId
        && a.contributionId === b.contributionId
        && a.artifactId === b.artifactId
        && a.artifactDigest === b.artifactDigest
        && a.platform === b.platform
        && installed.format === entry.format
        && installed.entryRelativePath === entry.entryRelativePath
        && (installed.files === undefined) === (entry.files === undefined);
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

async function persistentRecordHasValidIntegrity(
    record: PluginReactNativePersistentArtifactRecord,
    expected: PluginReactNativePersistentArtifactIdentity,
): Promise<boolean> {
    if (!persistentIdentityMatches(record.persistentIdentity, expected)) return false;
    // The record always carries the Artifact-owned exact file graph, so the
    // declared entry supplies the entry digest. A record whose declared entry
    // is missing from its own graph is invalid, never an entry-only record.
    const declaredEntry = record.files.find((file) => file.relativePath === record.entryRelativePath);
    if (!declaredEntry) return false;
    if (await computePluginUiArtifactSha256Digest(record.bytes) !== declaredEntry.digest) return false;
    for (const file of record.files) {
        if (file.bytes.byteLength !== file.byteSize) return false;
        if (await computePluginUiArtifactSha256Digest(file.bytes) !== file.digest) return false;
    }
    return await computePluginUiArtifactFileSetSha256Digest(
        record.files.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.bytes,
        })),
    ) === expected.artifactDigest;
}

export type CreatePluginReactNativeBundleCacheOptions = Readonly<{
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
            return store.write(record);
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
            const disposition = await input.store.write(record);
            if (!isCurrent()) {
                throw new Error('react_native_artifact_persistent_operation_invalidated');
            }
            return disposition;
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
    // Persistent storage is optional (for example in browser/test hosts), but
    // its absence must not revoke an otherwise-current Artifact lease. The
    // captured operation gates physical store work only; Account/cache
    // currentness continues to fence the selected lease and hot-cache write.
    const isCurrent = () => isCurrentLeaseCacheLifetime({
        cache: input.cache,
        lifetime: input.lifetime,
        scope: input.lifetime.scope,
    }) && (operation?.isCurrent() ?? true);
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
            if (!isCurrent()) return null;
            await operation?.awaitPendingPersistentArtifactRemoval(identity);
            if (!isCurrent()) return null;
            // The executable cache already holds the verified complete file set.
            // Reuse its Account-qualified bytes even on hosts without persistent storage.
            const hot = input.cache.readInstalledArtifact(identity, identity.accountScope);
            if (hot?.entryRelativePath && hot.files) return Object.freeze({
                persistentIdentity: identity,
                bytes: hot.bytes,
                entryRelativePath: hot.entryRelativePath,
                files: hot.files,
            });
            if (!canUseStore()) return null;
            const record = await operation?.readPersistentArtifact(identity) ?? null;
            return canUseStore() ? record : null;
        },
        write: async (record) => {
            if (!canUseStore()) {
                throw new Error('react_native_artifact_persistent_scope_retired');
            }
            const disposition = await operation?.writePersistentArtifact(record) ?? null;
            if (disposition === null || !canUseStore()) {
                throw new Error('react_native_artifact_persistent_write_invalidated');
            }
            return disposition;
        },
        remove: async (identity) => {
            if (!canRemovePersistentArtifact()) return;
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
    const persistentStore = options.persistentStore;
    const persistentCustody = options.persistentCustody ?? createPluginArtifactPersistentCustody({
        store: persistentStore as unknown as PluginUiPersistentArtifactStore | undefined,
        revokeNativeArtifactResourcesForAccount: options.revokeNativeArtifactResourcesForAccount,
        onDiagnostic: options.onPersistentCacheDiagnostic,
    });
    const hotEntryAccountScopes = new Map<string, string>();
    // One compiled program per installed digest. Only the single installed
    // loader backend compiles, so the slot holds that backend's program type.
    const programs = new Map<string, unknown>();
    const activeProjectionKeys = new Set<string>();
    const deleteEntry = (key: string): void => {
        entries.delete(key);
        hotEntryAccountScopes.delete(key);
        programs.delete(key);
    };
    // Before the reconciler observes its first complete source union, the
    // incumbent Artifact path may still be writing bytes for the mount which
    // is about to register that union. Afterwards, this existing set is the
    // sole write-currentness authority for every fenced identity.
    let hasReconciledActiveProjectionSources = false;

    function reconcileActiveProjectionIdentities(
        identities: readonly PluginReactNativeBundleCacheIdentity[],
    ): void {
        hasReconciledActiveProjectionSources = true;
        const nextKeys = new Set<string>();
        for (const identity of identities) {
            nextKeys.add(derivePluginReactNativeBundleCacheKey(identity));
        }
        const sourcesChanged = !(
            nextKeys.size === activeProjectionKeys.size
            && [...nextKeys].every((key) => activeProjectionKeys.has(key))
        );
        const hasUnownedEntry = [...entries.keys()].some(
            (key) => !nextKeys.has(key),
        );
        if (!sourcesChanged && !hasUnownedEntry) {
            return;
        }

        if (sourcesChanged) {
            activeProjectionKeys.clear();
            for (const key of nextKeys) activeProjectionKeys.add(key);
        }

        for (const key of [...entries.keys()]) {
            if (!activeProjectionKeys.has(key)) deleteEntry(key);
        }
    }

    function evictAccountHotArtifacts(scope: ServerAccountScope): void {
        const key = accountScopeKey(scope);
        for (const [cacheKey, entryScope] of hotEntryAccountScopes.entries()) {
            if (entryScope !== key) continue;
            deleteEntry(cacheKey);
        }
    }

    async function retireAccount(scope: ServerAccountScope): Promise<void> {
        evictAccountHotArtifacts(scope);
        await persistentCustody.retireAccount(scope);
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
        const key = derivePluginReactNativeBundleCacheKey(identity);
        if (isCurrent() && hotEntryAccountScopes.get(key) === accountScopeKey(identity.accountScope)) {
            deleteEntry(key);
        }
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
                        && !activeProjectionKeys.has(cacheKey)
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
            const installed = entries.get(cacheKey);
            if (installed && isSameInstalledArtifact(installed, entry)
                && hotEntryAccountScopes.get(cacheKey) === (entry.accountScope ? accountScopeKey(entry.accountScope) : undefined)) {
                // The digest keys the exact file graph: re-acquiring the same lease (every Session open/leave
                // remounts its surfaces) is not a new install, so it copies and compares no bytes.
                return Object.freeze({ ok: true, cacheKey });
            }
            programs.delete(cacheKey);
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
        readInstalledArtifact: (identity, scope) => {
            const key = derivePluginReactNativeBundleCacheKey(identity);
            if (scope && (!persistentCustody.isAccountCurrent(scope)
                || hotEntryAccountScopes.get(key) !== accountScopeKey(scope))) return null;
            const entry = entries.get(key);
            return entry
                ? Object.freeze({
                    ...entry,
                    bytes: cloneBytes(entry.bytes),
                    ...(entry.files ? { files: cloneCachedArtifactFiles(entry.files) } : {}),
                })
                : null;
        },
        readInstalledProgram: <TProgram>(
            identity: Pick<PluginReactNativeBundleCacheIdentity, 'artifactDigest'>,
            compile: (bytes: Uint8Array) => TProgram,
        ): TProgram | null => {
            const key = derivePluginReactNativeBundleCacheKey(identity);
            const entry = entries.get(key);
            if (!entry) return null;
            if (programs.has(key)) return programs.get(key) as TProgram;
            const program = compile(entry.bytes);
            if (entries.get(key) === entry) programs.set(key, program);
            return program;
        },
        readPersistentArtifact: async (identity) => {
            const operation = persistentCustody.capturePersistentAccountOperation({
                scope: identity.accountScope,
                isCurrent: () => true,
            });
            if (!operation) return null;
            try {
                // Custody returns already-admitted detached bytes. Match the
                // requested privacy partition without rehashing internal data.
                const record = await operation.readPersistentArtifact(identity) as PluginReactNativePersistentArtifactRecord | null;
                if (!record || !persistentIdentityMatches(record.persistentIdentity, identity)) {
                    if (record) await operation.removePersistentArtifact(identity);
                    return null;
                }
                return operation.isCurrent() ? record : null;
            } finally {
                operation.release();
            }
        },
        writePersistentArtifact: async (record) => {
            const operation = persistentCustody.capturePersistentAccountOperation({
                scope: record.persistentIdentity.accountScope,
                isCurrent: () => true,
            });
            if (!operation) return false;
            try {
                const detached = clonePersistentArtifactRecord(record);
                if (!await persistentRecordHasValidIntegrity(detached, detached.persistentIdentity)) return false;
                return (await operation.writePersistentArtifact(detached)) !== null;
            } finally {
                operation.release();
            }
        },
        removePersistentArtifact,
        removePersistentArtifactsForAccount: async (scope) => {
            evictAccountHotArtifacts(scope);
            await persistentCustody.removePersistentArtifactsForAccount(scope);
        },
        bindAccountLifetime: (lifetime) => {
            persistentCustody.bindAccountLifetime({
                ...lifetime,
                onRetire: (retire) => lifetime.onRetire(() => {
                    evictAccountHotArtifacts(lifetime.scope);
                    retire();
                }),
            });
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
}>;

function createDefaultNativeArtifactResourceRegistrar(): PluginNativeArtifactResourceRegistrar | null {
    if (isDesktopHost()) return createTauriPluginNativeArtifactResourceRegistrar();
    if (typeof globalThis.caches !== 'undefined') return null;
    return createExpoPluginNativeArtifactResourceRegistrar();
}

function createDefaultPersistentArtifactStore(
    registry: PluginNativeArtifactResourceRegistry | null,
): DefaultPersistentArtifactStore {
    if (isDesktopHost()) {
        const nativeStore = createTauriPluginUiPersistentArtifactStore();
        return Object.freeze({
            reactNativeStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(nativeStore),
            nativeStore,
        });
    }
    if (typeof globalThis.caches !== 'undefined') {
        const browserStore = createBrowserPluginUiPersistentArtifactStore(globalThis.caches);
        return Object.freeze({
            reactNativeStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(browserStore),
            nativeStore: null,
        });
    }
    const nativeStore = createReactNativePersistentArtifactStore({
        isPersistentArtifactIdentityInUse: (identityKey) => (
            registry?.isPersistentArtifactIdentityInUse(identityKey) ?? false
        ),
    });
    return Object.freeze({
        reactNativeStore: adaptPluginUiPersistentArtifactStoreForReactNativeBundleCache(nativeStore),
        nativeStore,
    });
}

export type InstalledPluginNativeArtifactResources = Readonly<{
    /** The native-token-gated store; the raw filesystem store is never exported. */
    nativePersistentStore: PluginNativeArtifactPersistentStore;
    registry: PluginNativeArtifactResourceRegistry;
}>;

const nativeResourceRegistrar = createDefaultNativeArtifactResourceRegistrar();
const installedNativeArtifactRegistry = nativeResourceRegistrar
    ? createPluginNativeArtifactResourceRegistry({ registrar: nativeResourceRegistrar })
    : null;
const defaultPersistentArtifactStore = createDefaultPersistentArtifactStore(installedNativeArtifactRegistry);
const nativeStore = defaultPersistentArtifactStore.nativeStore;
const installedNativeArtifactComposition = nativeStore && installedNativeArtifactRegistry
    ? createPluginReactNativeBundleCacheWithNativeArtifactResources({
        persistentStore: nativeStore,
        registry: installedNativeArtifactRegistry,
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
    type PluginReactNativeBundleCacheIdentity,
};
