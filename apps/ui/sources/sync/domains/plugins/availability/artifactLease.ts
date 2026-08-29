import {
    arePluginMachineMaterializationRefsEqual,
    isPluginMachineMaterializationOnServerIdentityV1,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactsManifestEntryV1Schema,
    verifyPluginUiArtifactBytesIntegrityV1,
    verifyPluginUiArtifactFileSetIntegrityV1,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginAccountAvailabilityArtifactAdmission,
    PluginAccountAvailabilityArtifactFact,
    PluginAccountAvailabilityArtifactSlot,
    PluginAccountAvailabilityReader,
} from './reader';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type {
    PluginUiPersistentArtifactFile,
    PluginUiPersistentArtifactIdentity,
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';

export type PluginArtifactSourceKind =
    | 'appExact'
    | 'persistentCache'
    | 'daemon'
    | 'accountHosted';

export type PluginSelectedArtifactIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    tier: 'declarative' | 'hostedWeb' | 'reactNative';
    platform: 'web' | 'ios' | 'android';
    digest: PluginUiArtifactDigestV1;
    releaseVersion: string;
    availabilityCursor: number;
}>;

/**
 * Source-local provenance carried beside the selected immutable Artifact
 * identity. Account hosting consumes this only to address its current link;
 * it must not affect selected-byte identity, lease currentness, or cache
 * custody.
 */
export type PluginArtifactSourceReadInput = Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    relativePath: string;
    accountHostedArtifactId?: string;
}>;

/**
 * A concrete source adapter receives the current immutable Artifact identity,
 * one declared file path, and only Account-hosted source provenance when that
 * specific adapter needs it. It owns transport details privately; no renderer
 * receives a daemon RPC shape, URL, cache key, or source choice.
 */
export type PluginArtifactSourceCandidate = Readonly<{
    kind: PluginArtifactSourceKind;
    readFile: (input: PluginArtifactSourceReadInput) => Promise<Uint8Array | null>;
    /**
     * Persistent byte custody can atomically remove one verified-entry key
     * when the lease proves that its complete declared file graph is invalid.
     */
    discardInvalid?: () => Promise<void>;
}>;

export type PluginSelectedArtifactLeaseFileResult =
    | Readonly<{
        kind: 'available';
        file: PluginUiArtifactFileV1;
        bytes: Uint8Array;
    }>
    | Readonly<{
        kind: 'unavailable';
        code: 'artifact_file_not_declared' | 'artifact_lease_revoked';
    }>;

export type PluginSelectedArtifactLease = Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    /** The one fully verified source that supplied this private handle. */
    sourceKind: PluginArtifactSourceKind;
    artifactGraph: PluginUiArtifactsManifestEntryV1;
    files: readonly PluginUiArtifactFileV1[];
    readFile: (relativePath: string) => Promise<PluginSelectedArtifactLeaseFileResult>;
    isCurrent: () => boolean;
    onRevoke: (listener: () => void) => Readonly<{ dispose: () => void }>;
    dispose: () => void;
}>;

export type PluginSelectedArtifactLeaseAcquireResult =
    | Readonly<{ kind: 'available'; lease: PluginSelectedArtifactLease }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | Extract<PluginAccountAvailabilityArtifactAdmission, { kind: 'unavailable' }>['code']
            | 'artifact_graph_invalid'
            | 'artifact_graph_mismatch'
            | 'artifact_source_ambiguous'
            | 'artifact_source_integrity_invalid'
            | 'artifact_source_unavailable'
            | 'artifact_lease_revoked';
    }>;

const SOURCE_RANK: Readonly<Record<PluginArtifactSourceKind, number>> = Object.freeze({
    persistentCache: 0,
    appExact: 1,
    daemon: 2,
    accountHosted: 3,
});

function cloneArtifactFact(
    fact: PluginAccountAvailabilityArtifactFact,
    availabilityCursor: number,
): PluginSelectedArtifactIdentity {
    return Object.freeze({
        pluginId: fact.pluginId,
        contributionId: fact.contributionId,
        tier: fact.tier,
        platform: fact.platform,
        digest: fact.digest,
        releaseVersion: fact.releaseVersion,
        availabilityCursor,
    });
}

function sameArtifactIdentity(
    left: PluginSelectedArtifactIdentity,
    right: PluginAccountAvailabilityArtifactAdmission,
): boolean {
    return right.kind === 'available'
        && left.pluginId === right.artifact.pluginId
        && left.contributionId === right.artifact.contributionId
        && left.tier === right.artifact.tier
        && left.platform === right.artifact.platform
        && left.digest === right.artifact.digest
        && left.releaseVersion === right.artifact.releaseVersion;
}

/**
 * The one exact daemon-origin currentness decision shared by every Artifact
 * family. Family adapters first prove their cache identity, then delegate the
 * Account/materialization/release/slot facts here instead of maintaining
 * lockstep hosted-web and React-Native copies.
 */
export function isExactDaemonPluginArtifactOriginCurrent(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    origin: PluginMachineExecutionOriginV1;
    artifact: PluginSelectedArtifactIdentity;
}>): boolean {
    if (input.origin.materializationRef.pluginId !== input.artifact.pluginId) return false;
    const admission = input.reader.readMaterializations();
    if (admission.kind !== 'available') return false;
    const matching = admission.materializations.filter((materialization) => (
        isPluginMachineMaterializationOnServerIdentityV1(materialization, input.origin.serverIdentityId)
        && arePluginMachineMaterializationRefsEqual(materialization, input.origin.materializationRef)
    ));
    if (matching.length !== 1) return false;
    const materialization = matching[0]!;
    if (
        !materialization.portableRelease
        || !materialization.enabled
        || materialization.trustState !== 'trusted'
        || materialization.version !== input.artifact.releaseVersion
    ) {
        return false;
    }
    const release = input.reader.classifyRelease(materialization);
    if (
        release.serverIdentityId !== input.origin.serverIdentityId
        || !arePluginMachineMaterializationRefsEqual(materialization, release.materializationRef)
        || release.releaseContent !== 'matched'
        || release.validation.kind !== 'admitted'
    ) {
        return false;
    }
    return materialization.uiArtifacts.some((slot) => (
        slot.contributionId === input.artifact.contributionId
        && slot.tier === input.artifact.tier
        && slot.platform === input.artifact.platform
        && slot.artifactDigest === input.artifact.digest
    ));
}

function isGraphCompatible(
    graph: PluginUiArtifactsManifestEntryV1,
    artifact: PluginSelectedArtifactIdentity,
): boolean {
    return graph.contributionId === artifact.contributionId
        && graph.tier === artifact.tier
        && (graph.platform === undefined || graph.platform === artifact.platform)
        && graph.digest === artifact.digest;
}

function artifactKindFor(tier: PluginSelectedArtifactIdentity['tier']): string {
    return tier === 'reactNative' ? 'reactNativeBundle' : 'hostedWebAsset';
}

function orderedSources(
    sources: readonly PluginArtifactSourceCandidate[],
): readonly PluginArtifactSourceCandidate[] | null {
    const byKind = new Map<PluginArtifactSourceKind, PluginArtifactSourceCandidate>();
    for (const source of sources) {
        if (byKind.has(source.kind)) return null;
        byKind.set(source.kind, source);
    }
    return Object.freeze([...byKind.values()].sort((left, right) => (
        SOURCE_RANK[left.kind] - SOURCE_RANK[right.kind]
    )));
}

function cloneFile(file: PluginUiArtifactFileV1): PluginUiArtifactFileV1 {
    return Object.freeze({ ...file });
}

export type PluginArtifactVerifiedSourceFile = Readonly<{
    file: PluginUiArtifactFileV1;
    bytes: Uint8Array;
}>;

export type PluginArtifactVerifiedSourceResult =
    | Readonly<{
        kind: 'available';
        source: PluginArtifactSourceCandidate;
        files: readonly PluginArtifactVerifiedSourceFile[];
    }>
    | Readonly<{ kind: 'notCurrent' }>
    | Readonly<{ kind: 'unavailable'; integrityFailed: boolean }>;

export type PluginArtifactLeasePersistentScope = Readonly<{
    scope: ServerAccountScope;
    store: PluginUiPersistentArtifactStore;
    isCurrent: () => boolean;
    removePersistentArtifact: (identity: PluginUiPersistentArtifactIdentity) => Promise<void>;
}>;

/**
 * Account-qualified physical Artifact custody. This is deliberately separate
 * from the RN executable/materialization cache: it owns only persistent bytes,
 * Account generations, exact-key deletion ordering, and forget quarantine.
 */
export type PluginArtifactPersistentAccountOperation = Readonly<{
    scope: ServerAccountScope;
    isCurrent: () => boolean;
    isCacheCurrent: () => boolean;
    isOpen: () => boolean;
    readPersistentArtifact: (identity: PluginUiPersistentArtifactIdentity) => Promise<PluginUiPersistentArtifactRecord | null>;
    writePersistentArtifact: (record: PluginUiPersistentArtifactRecord) => Promise<boolean>;
    awaitPendingPersistentArtifactRemoval: (identity: PluginUiPersistentArtifactIdentity) => Promise<void>;
    removePersistentArtifact: (identity: PluginUiPersistentArtifactIdentity) => Promise<void>;
    removePersistentArtifactsForAccount: () => Promise<void>;
    release: () => void;
}>;

export type PluginArtifactPersistentCustody = Readonly<{
    store: PluginUiPersistentArtifactStore | undefined;
    capturePersistentAccountOperation: (input: Readonly<{
        scope: ServerAccountScope;
        isCurrent: () => boolean;
    }>) => PluginArtifactPersistentAccountOperation | null;
    readPersistentArtifact: (identity: PluginUiPersistentArtifactIdentity) => Promise<PluginUiPersistentArtifactRecord | null>;
    writePersistentArtifact: (record: PluginUiPersistentArtifactRecord) => Promise<boolean>;
    removePersistentArtifact: (identity: PluginUiPersistentArtifactIdentity, isCurrent?: () => boolean) => Promise<void>;
    removePersistentArtifactsForAccount: (scope: ServerAccountScope) => Promise<void>;
    bindAccountLifetime: (lifetime: Readonly<{
        scope: ServerAccountScope;
        isCurrent: () => boolean;
        onRetire: (cancel: () => void) => Readonly<{ dispose: () => void }>;
    }>) => void;
    isAccountCurrent: (scope: ServerAccountScope) => boolean;
    retireAccount: (scope: ServerAccountScope) => Promise<void>;
}>;

function clonePersistentArtifactRecord(record: PluginUiPersistentArtifactRecord): PluginUiPersistentArtifactRecord {
    return Object.freeze({
        ...record,
        persistentIdentity: Object.freeze({
            ...record.persistentIdentity,
            accountScope: Object.freeze({ ...record.persistentIdentity.accountScope }),
        }),
        bytes: new Uint8Array(record.bytes),
        files: Object.freeze(record.files.map((file) => Object.freeze({
            ...file,
            bytes: new Uint8Array(file.bytes),
        }))),
    });
}

export function createPluginArtifactPersistentCustody(options: Readonly<{
    store?: PluginUiPersistentArtifactStore;
    revokeNativeArtifactResourcesForAccount?: (scope: ServerAccountScope) => void;
    onDiagnostic?: (code: string) => void;
}> = {}): PluginArtifactPersistentCustody {
    const store = options.store;
    const retiredAccounts = new Set<string>();
    const quarantinedAccounts = new Set<string>();
    const quarantinedKeys = new Set<string>();
    const pendingAccountCleanups = new Map<string, Promise<void>>();
    const pendingRemovals = new Map<string, Promise<void>>();
    const generations = new Map<string, number>();
    const activeOperations = new Map<string, number>();
    const lifetimes = new Map<string, Readonly<{ dispose: () => void }>>();

    const accountKey = (scope: ServerAccountScope) => derivePluginUiPersistentArtifactAccountKey(scope);
    const artifactKey = derivePluginUiPersistentArtifactKey;
    const generation = (key: string) => generations.get(key) ?? 0;
    const activeCount = (key: string) => activeOperations.get(key) ?? 0;
    const usable = (scope: ServerAccountScope) => {
        const key = accountKey(scope);
        return !retiredAccounts.has(key) && !quarantinedAccounts.has(key);
    };
    const awaitRemoval = async (key: string) => {
        while (true) {
            const pending = pendingRemovals.get(key);
            if (!pending) return;
            await pending.catch(() => undefined);
        }
    };

    let removeAccount: (scope: ServerAccountScope) => Promise<void> = async () => undefined;
    const capture = (input: Readonly<{ scope: ServerAccountScope; isCurrent: () => boolean }>): PluginArtifactPersistentAccountOperation | null => {
        const key = accountKey(input.scope);
        const capturedGeneration = generation(key);
        const isCacheCurrent = () => generation(key) === capturedGeneration && usable(input.scope);
        const isCurrent = () => {
            try { return input.isCurrent() && isCacheCurrent(); } catch { return false; }
        };
        if (!store || !isCurrent()) return null;
        activeOperations.set(key, activeCount(key) + 1);
        let open = true;
        const operation: PluginArtifactPersistentAccountOperation = Object.freeze({
            scope: input.scope,
            isCurrent,
            isCacheCurrent,
            isOpen: () => open,
            readPersistentArtifact: async (identity) => {
                if (!open || !isCurrent() || !areServerAccountScopesEqual(identity.accountScope, input.scope)) return null;
                const key = artifactKey(identity);
                if (quarantinedKeys.has(key)) {
                    void removePersistentArtifact(identity).catch(() => undefined);
                    return null;
                }
                await awaitRemoval(key);
                if (!open || !isCurrent()) return null;
                const record = await store.read(identity).catch(() => {
                    options.onDiagnostic?.('plugin_ui_artifact_cache_read_failed');
                    return null;
                });
                return open && isCurrent() && record ? clonePersistentArtifactRecord(record) : null;
            },
            writePersistentArtifact: async (record) => {
                if (!open || !isCurrent() || !areServerAccountScopesEqual(record.persistentIdentity.accountScope, input.scope)) return false;
                const key = artifactKey(record.persistentIdentity);
                await awaitRemoval(key);
                if (!open || !isCurrent()) return false;
                try {
                    await store.write(clonePersistentArtifactRecord(record));
                    quarantinedKeys.delete(key);
                } catch {
                    options.onDiagnostic?.('plugin_ui_artifact_cache_write_failed');
                    return false;
                }
                return open && isCurrent();
            },
            awaitPendingPersistentArtifactRemoval: async (identity) => {
                if (areServerAccountScopesEqual(identity.accountScope, input.scope)) await awaitRemoval(artifactKey(identity));
            },
            removePersistentArtifact: (identity) => areServerAccountScopesEqual(identity.accountScope, input.scope)
                ? removePersistentArtifact(identity, () => open && isCurrent())
                : Promise.resolve(),
            removePersistentArtifactsForAccount: () => removeAccount(input.scope),
            release: () => {
                if (!open) return;
                open = false;
                const remaining = activeCount(key) - 1;
                if (remaining > 0) activeOperations.set(key, remaining);
                else {
                    activeOperations.delete(key);
                    if (quarantinedAccounts.has(key) && !pendingAccountCleanups.has(key)) void removeAccount(input.scope);
                }
            },
        });
        return operation;
    };

    const removePersistentArtifact = async (identity: PluginUiPersistentArtifactIdentity, isCurrent: () => boolean = () => true): Promise<void> => {
        const operation = capture({ scope: identity.accountScope, isCurrent });
        if (!store || !operation) return;
        const key = artifactKey(identity);
        const preceding = pendingRemovals.get(key);
        let removal!: Promise<void>;
        removal = (async () => {
            try {
                if (preceding) await preceding.catch(() => undefined);
                if (!operation.isCurrent()) return;
                await store.remove(identity);
                quarantinedKeys.delete(key);
            } catch {
                options.onDiagnostic?.('plugin_ui_artifact_cache_delete_failed');
                quarantinedKeys.add(key);
            } finally {
                operation.release();
            }
        })().finally(() => {
            if (pendingRemovals.get(key) === removal) pendingRemovals.delete(key);
        });
        pendingRemovals.set(key, removal);
        await removal;
    };

    removeAccount = async (scope) => {
        if (!store) return;
        const key = accountKey(scope);
        const existing = pendingAccountCleanups.get(key);
        if (existing) return existing;
        quarantinedAccounts.add(key);
        const startedWithActiveOperations = activeCount(key) > 0;
        let succeeded = false;
        let cleanup!: Promise<void>;
        cleanup = Promise.resolve().then(() => store.removeAccount(scope)).then(() => {
            succeeded = true;
            if (!startedWithActiveOperations && activeCount(key) === 0) quarantinedAccounts.delete(key);
        }).catch(() => {
            options.onDiagnostic?.('plugin_ui_artifact_account_cache_delete_failed');
        }).finally(() => {
            if (pendingAccountCleanups.get(key) === cleanup) pendingAccountCleanups.delete(key);
            if (succeeded && startedWithActiveOperations && quarantinedAccounts.has(key) && activeCount(key) === 0) void removeAccount(scope);
        });
        pendingAccountCleanups.set(key, cleanup);
        return cleanup;
    };

    const retireAccount = async (scope: ServerAccountScope): Promise<void> => {
        const key = accountKey(scope);
        generations.set(key, generation(key) + 1);
        retiredAccounts.add(key);
        lifetimes.get(key)?.dispose();
        lifetimes.delete(key);
        options.revokeNativeArtifactResourcesForAccount?.(scope);
    };

    return Object.freeze({
        store,
        capturePersistentAccountOperation: capture,
        readPersistentArtifact: async (identity) => {
            const operation = capture({ scope: identity.accountScope, isCurrent: () => true });
            if (!operation) return null;
            try { return await operation.readPersistentArtifact(identity); } finally { operation.release(); }
        },
        writePersistentArtifact: async (record) => {
            const operation = capture({ scope: record.persistentIdentity.accountScope, isCurrent: () => true });
            if (!operation) return false;
            try { return await operation.writePersistentArtifact(record); } finally { operation.release(); }
        },
        removePersistentArtifact,
        removePersistentArtifactsForAccount: removeAccount,
        bindAccountLifetime: (lifetime) => {
            const key = accountKey(lifetime.scope);
            lifetimes.get(key)?.dispose();
            if (!lifetime.isCurrent()) {
                retiredAccounts.add(key);
                lifetimes.delete(key);
                return;
            }
            retiredAccounts.delete(key);
            if (quarantinedAccounts.has(key) && !pendingAccountCleanups.has(key) && activeCount(key) === 0) void removeAccount(lifetime.scope);
            lifetimes.set(key, lifetime.onRetire(() => { void retireAccount(lifetime.scope); }));
        },
        isAccountCurrent: (scope) => !retiredAccounts.has(accountKey(scope)),
        retireAccount,
    });
};

function persistentIdentityFor(input: Readonly<{
    scope: ServerAccountScope;
    artifact: PluginSelectedArtifactIdentity;
}>): PluginUiPersistentArtifactIdentity {
    return Object.freeze({
        accountScope: input.scope,
        releaseVersion: input.artifact.releaseVersion,
        pluginId: input.artifact.pluginId,
        contributionId: input.artifact.contributionId,
        tier: input.artifact.tier,
        platform: input.artifact.platform,
        artifactDigest: input.artifact.digest,
    });
}

export function isPluginArtifactPersistentScopeCurrent(
    scope: PluginArtifactLeasePersistentScope | undefined,
): boolean {
    return scope ? scope.isCurrent() : true;
}

export function createPluginArtifactPersistentSource<TIdentity>(input: Readonly<{
    scope: PluginArtifactLeasePersistentScope;
    identity: TIdentity;
    artifactMatchesIdentity: (artifact: PluginSelectedArtifactIdentity, identity: TIdentity) => boolean;
}>): PluginArtifactSourceCandidate {
    let pending: Promise<PluginUiPersistentArtifactRecord | null> | null = null;
    let persistentIdentityKey = '';
    let loadedIdentity: PluginUiPersistentArtifactIdentity | null = null;
    let loadedRecord: PluginUiPersistentArtifactRecord | null = null;
    const clearLoaded = () => {
        const identity = loadedIdentity;
        loadedIdentity = null;
        loadedRecord = null;
        pending = Promise.resolve(null);
        return identity;
    };
    return Object.freeze({
        kind: 'persistentCache',
        readFile: async ({ artifact, relativePath }) => {
            if (!input.scope.isCurrent() || !input.artifactMatchesIdentity(artifact, input.identity)) return null;
            const persistentIdentity = persistentIdentityFor({ scope: input.scope.scope, artifact });
            const currentKey = [
                persistentIdentity.releaseVersion,
                persistentIdentity.pluginId,
                persistentIdentity.contributionId,
                persistentIdentity.tier,
                persistentIdentity.platform,
                persistentIdentity.artifactDigest,
            ].join('\u0000');
            if (currentKey !== persistentIdentityKey) {
                persistentIdentityKey = currentKey;
                loadedIdentity = persistentIdentity;
                loadedRecord = null;
                pending = input.scope.store.read(persistentIdentity)
                    .then((record) => {
                        loadedRecord = record;
                        return record;
                    })
                    .catch(() => null);
            }
            const record = await pending;
            if (!record || !input.scope.isCurrent()) return null;
            const file = record.files.find((candidate) => candidate.relativePath === relativePath);
            return file ? new Uint8Array(file.bytes) : null;
        },
        discardInvalid: async () => {
            if (!input.scope.isCurrent() || !loadedIdentity || !loadedRecord) return;
            const identity = clearLoaded();
            if (identity) await input.scope.removePersistentArtifact(identity);
        },
    });
}

export function wrapPluginArtifactLeaseCurrentness(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    reader: PluginAccountAvailabilityReader;
    isAdditionalCurrent: () => boolean;
}>): PluginSelectedArtifactLease {
    const revokeListeners = new Set<() => void>();
    let revoked = false;
    let disposed = false;
    const revoke = () => {
        if (revoked) return;
        revoked = true;
        for (const listener of revokeListeners) {
            try { listener(); } catch { /* notify every independent listener */ }
        }
        revokeListeners.clear();
    };
    const isCurrent = () => {
        if (revoked || !input.lease.isCurrent() || !input.isAdditionalCurrent()) {
            revoke();
            return false;
        }
        return true;
    };
    const accountSubscription = input.reader.subscribe(isCurrent);
    const leaseSubscription = input.lease.onRevoke(revoke);
    return Object.freeze({
        ...input.lease,
        isCurrent,
        readFile: async (relativePath) => {
            if (!isCurrent()) return Object.freeze({ kind: 'unavailable' as const, code: 'artifact_lease_revoked' as const });
            const result = await input.lease.readFile(relativePath);
            return isCurrent()
                ? result
                : Object.freeze({ kind: 'unavailable' as const, code: 'artifact_lease_revoked' as const });
        },
        onRevoke: (listener) => {
            if (revoked) {
                listener();
                return Object.freeze({ dispose: () => {} });
            }
            revokeListeners.add(listener);
            return Object.freeze({ dispose: () => revokeListeners.delete(listener) });
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            accountSubscription();
            leaseSubscription.dispose();
            input.lease.dispose();
            revoke();
        },
    });
}

export async function persistVerifiedPluginArtifactLease(input: Readonly<{
    lease: PluginSelectedArtifactLease;
    persistent: PluginArtifactLeasePersistentScope;
}>): Promise<void> {
    if (!input.persistent.isCurrent() || !input.lease.isCurrent()) return;
    const files: PluginUiPersistentArtifactFile[] = [];
    for (const declared of input.lease.files) {
        const result = await input.lease.readFile(declared.relativePath);
        if (result.kind !== 'available' || !input.persistent.isCurrent() || !input.lease.isCurrent()) return;
        files.push(Object.freeze({
            relativePath: result.file.relativePath,
            digest: result.file.digest,
            byteSize: result.file.byteSize,
            bytes: new Uint8Array(result.bytes),
        }));
    }
    const entry = files.find((file) => file.relativePath === input.lease.artifactGraph.entry);
    if (!entry || !input.persistent.isCurrent() || !input.lease.isCurrent()) return;
    const persistentIdentity = persistentIdentityFor({
        scope: input.persistent.scope,
        artifact: input.lease.artifact,
    });
    try {
        await input.persistent.store.write(Object.freeze({
            persistentIdentity,
            bytes: new Uint8Array(entry.bytes),
            entryRelativePath: input.lease.artifactGraph.entry,
            files: Object.freeze(files),
        }));
    } catch {
        return;
    }
    // A write that lands is retained. Account/scope custody is fenced inside the
    // persistent store owner, which refuses a retired scope outright, so undoing
    // the write here could only fire on ordinary lease currentness loss — and
    // would throw away bytes this acquisition just paid for.
}

/**
 * The one verified-source materializer. It walks already-ordered candidates,
 * reads every declared file, and admits a source only when each file and the
 * complete declared file set pass canonical integrity. It owns no lease,
 * lifetime, cache custody, or result vocabulary: callers keep their own
 * currentness owner and map the outcome to their own typed codes.
 */
export async function materializeVerifiedPluginArtifactSource(input: Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    graph: PluginUiArtifactsManifestEntryV1;
    /** Already ordered by the caller's admitted source order. */
    sources: readonly PluginArtifactSourceCandidate[];
    isCurrent: () => boolean;
    /** Supplied only when the Account-hosted source needs its current link. */
    accountHostedArtifactId?: string;
}>): Promise<PluginArtifactVerifiedSourceResult> {
    let sawIntegrityFailure = false;
    for (const source of input.sources) {
        const materialized: PluginArtifactVerifiedSourceFile[] = [];
        let sourceUsable = true;
        for (const declared of input.graph.files) {
            if (!input.isCurrent()) return Object.freeze({ kind: 'notCurrent' });
            let bytes: Uint8Array | null;
            try {
                bytes = await source.readFile({
                    artifact: input.artifact,
                    relativePath: declared.relativePath,
                    ...(source.kind === 'accountHosted' && input.accountHostedArtifactId
                        ? { accountHostedArtifactId: input.accountHostedArtifactId }
                        : {}),
                });
            } catch {
                bytes = null;
            }
            if (!input.isCurrent()) return Object.freeze({ kind: 'notCurrent' });
            if (!bytes) {
                sourceUsable = false;
                break;
            }
            if (bytes.byteLength !== declared.byteSize) {
                sawIntegrityFailure = true;
                sourceUsable = false;
                break;
            }
            const integrity = verifyPluginUiArtifactBytesIntegrityV1({
                bytes,
                integrity: {
                    digest: declared.digest,
                    pluginId: input.artifact.pluginId,
                    contributionId: input.artifact.contributionId,
                    artifactKind: artifactKindFor(input.artifact.tier),
                },
            });
            if (!integrity.ok) {
                sawIntegrityFailure = true;
                sourceUsable = false;
                break;
            }
            materialized.push(Object.freeze({ file: cloneFile(declared), bytes: new Uint8Array(bytes) }));
        }
        if (!sourceUsable) {
            await discardInvalidPersistentSource(source);
            continue;
        }
        const setIntegrity = verifyPluginUiArtifactFileSetIntegrityV1({
            files: materialized.map(({ file, bytes }) => ({ relativePath: file.relativePath, bytes })),
            integrity: {
                digest: input.artifact.digest,
                pluginId: input.artifact.pluginId,
                contributionId: input.artifact.contributionId,
                artifactKind: artifactKindFor(input.artifact.tier),
            },
        });
        if (!setIntegrity.ok) {
            sawIntegrityFailure = true;
            await discardInvalidPersistentSource(source);
            continue;
        }
        return Object.freeze({
            kind: 'available',
            source,
            files: Object.freeze(materialized),
        });
    }
    return Object.freeze({ kind: 'unavailable', integrityFailed: sawIntegrityFailure });
}

async function discardInvalidPersistentSource(source: PluginArtifactSourceCandidate): Promise<void> {
    if (source.kind !== 'persistentCache') return;
    const discardInvalid = source.discardInvalid;
    if (!discardInvalid) return;
    await discardInvalid().catch(() => undefined);
}

/**
 * Resolves one current Artifact through the only permitted source order, fully
 * verifies its declared file graph, and returns a revocable private lease. The
 * returned lease has no transport/cache/source authority; renderer consumers
 * can only read declared already-verified bytes while it remains current.
 */
export async function acquirePluginSelectedArtifactLease(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    slot: PluginAccountAvailabilityArtifactSlot;
    artifactGraph: unknown;
    sources: readonly PluginArtifactSourceCandidate[];
}>): Promise<PluginSelectedArtifactLeaseAcquireResult> {
    const admission = input.reader.readCurrentArtifact(input.slot);
    if (admission.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: admission.code });
    }
    const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(input.artifactGraph);
    if (!graph.success) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_invalid' });
    }
    const artifact = cloneArtifactFact(admission.artifact, admission.availabilityCursor);
    if (!isGraphCompatible(graph.data, artifact)) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_mismatch' });
    }
    const sources = orderedSources(input.sources);
    if (!sources) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_source_ambiguous' });
    }
    if (sources.length === 0) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_source_unavailable' });
    }

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
                // Every subscriber must get an independent revocation signal.
            }
        }
        revokeListeners.clear();
    };
    // Losing the current admission retires this lease's reachability; it never
    // deletes the retained verified bytes. Bootstrap, resume, and every
    // level-triggered AccountChange withdraw the projection before one coalesced
    // refresh re-supplies it, so deleting here would charge the same Account a
    // full re-download for ordinary currentness loss. Ordinary replacement and
    // withdrawal are retirement only, including `A -> B -> A`; physical deletion
    // belongs to the invalid-record discard below, the cache's own corruption
    // and eviction owners, and the logout/forget Account-wide owner.
    const isCurrent = () => {
        if (revoked) return false;
        if (!sameArtifactIdentity(artifact, input.reader.readCurrentArtifact(input.slot))) {
            revoke();
            return false;
        }
        return true;
    };
    unsubscribe = input.reader.subscribe(() => {
        isCurrent();
    });

    const materializedSource = await materializeVerifiedPluginArtifactSource({
        artifact,
        graph: graph.data,
        sources,
        isCurrent,
        ...(admission.artifact.accountArtifactId
            ? { accountHostedArtifactId: admission.artifact.accountArtifactId }
            : {}),
    });
    if (materializedSource.kind === 'notCurrent') {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    if (materializedSource.kind === 'unavailable') {
        unsubscribe?.();
        unsubscribe = null;
        return Object.freeze({
            kind: 'unavailable',
            code: materializedSource.integrityFailed
                ? 'artifact_source_integrity_invalid'
                : 'artifact_source_unavailable',
        });
    }
    const files = new Map(materializedSource.files.map(
        ({ file, bytes }) => [file.relativePath, { file, bytes }] as const,
    ));
    const readFile = async (relativePath: string): Promise<PluginSelectedArtifactLeaseFileResult> => {
        if (!isCurrent()) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        }
        const record = files.get(relativePath);
        if (!record) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_file_not_declared' });
        }
        return Object.freeze({
            kind: 'available',
            file: record.file,
            bytes: new Uint8Array(record.bytes),
        });
    };
    return Object.freeze({
        kind: 'available',
        lease: Object.freeze({
            artifact,
            sourceKind: materializedSource.source.kind,
            artifactGraph: graph.data,
            files: Object.freeze(graph.data.files.map(cloneFile)),
            readFile,
            isCurrent,
            onRevoke: (listener: () => void) => {
                if (revoked) {
                    listener();
                    return Object.freeze({ dispose: () => {} });
                }
                revokeListeners.add(listener);
                return Object.freeze({
                    dispose: () => {
                        revokeListeners.delete(listener);
                    },
                });
            },
            dispose: revoke,
        }),
    });
}
