import {
    PluginUiArtifactsManifestEntryV2Schema,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV2,
} from '@happier-dev/protocol/plugins/ui';
import {
    computePluginUiArtifactSha256Digest,
    computePluginUiArtifactFileSetSha256Digest,
} from '@/sync/domains/plugins/ui/artifactIntegrity';

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
    PluginUiPersistentArtifactWriteDisposition,
} from '@/sync/domains/plugins/ui/artifactByteCache';

export type PluginArtifactSourceKind =
    | 'appExact'
    | 'persistentCache'
    | 'daemon'
    | 'accountHosted';

export type PluginSelectedArtifactIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactId: string;
    tier: 'declarative' | 'hostedWeb' | 'reactNative';
    platform: 'web' | 'ios' | 'android';
    digest: PluginUiArtifactDigestV1;
    hostUiApiRange: string;
    releaseVersion: string;
}>;

/**
 * Addressing for the daemon byte source: the machine that projected (bundled/
 * development) or serves (portable) the selected digest. It is transport
 * only, never admission; the returned bytes are SHA-verified like any source.
 */
export type PluginArtifactDaemonTransport = Readonly<{
    machineId: string;
    serverId: string;
}>;

/**
 * Exact non-portable Artifact selected by one admitted daemon projection.
 * The projection supplies semantic selection/currentness only; every source
 * still has to return bytes matching this selected digest and graph.
 */
export type PluginDaemonProjectionArtifactSelection = Readonly<{
    occurrenceId: string;
    artifact: PluginAccountAvailabilityArtifactFact;
    isCurrent: () => boolean;
}>;

/**
 * A bundled/development selection made by one daemon's admitted projection.
 * It carries that projecting daemon as its byte route, so an originless
 * selection always has a daemon source for its exact digest.
 */
export type PluginArtifactDaemonProjectionSelectionInput = Readonly<{
    occurrenceId: string;
    contributionId: string;
    releaseVersion: string;
    /** The daemon whose projection made this selection. */
    transport?: PluginArtifactDaemonTransport;
    isCurrent: () => boolean;
}>;

type PluginSelectedArtifactAdmission =
    | Readonly<{
        kind: 'available';
        artifact: PluginAccountAvailabilityArtifactFact;
    }>
    | Extract<PluginAccountAvailabilityArtifactAdmission, { kind: 'unavailable' }>;

/**
 * One byte request: the selected digest plus the selected slot facts. Digest is
 * the byte identity; Account hosting additionally needs its current link id
 * because the server authorizes that read by link. No source receives or
 * decides currentness.
 */
export type PluginArtifactByteRequest = Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    accountHostedArtifactId?: string;
    signal?: AbortSignal;
}>;

/** A source's complete file set for one digest, keyed by relative path. */
export type PluginArtifactFileSet = ReadonlyMap<string, Uint8Array>;

/**
 * The one byte-source interface. Every source (app preseed, device cache,
 * daemon, Account hosting) returns the complete file set for the requested
 * digest or `null` for a miss/failure. Integrity is verified once by the
 * lease; a source has no admission, selection, or currentness authority.
 */
export type PluginArtifactSourceCandidate = Readonly<{
    kind: PluginArtifactSourceKind;
    fetch: (request: PluginArtifactByteRequest) => Promise<PluginArtifactFileSet | null>;
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
    artifactGraph: PluginUiArtifactsManifestEntryV2;
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

const SOURCE_ORDER = Object.freeze([
    'persistentCache',
    'appExact',
    'daemon',
    'accountHosted',
] satisfies readonly PluginArtifactSourceKind[]);

function cloneArtifactFact(
    fact: PluginAccountAvailabilityArtifactFact,
): PluginSelectedArtifactIdentity {
    return Object.freeze({
        pluginId: fact.pluginId,
        contributionId: fact.contributionId,
        artifactId: fact.artifactId,
        tier: fact.tier,
        platform: fact.platform,
        digest: fact.digest,
        hostUiApiRange: fact.hostUiApiRange,
        releaseVersion: fact.releaseVersion,
    });
}

function readSelectedArtifactAdmission(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    slot: PluginAccountAvailabilityArtifactSlot;
    daemonProjectionSelection?: PluginDaemonProjectionArtifactSelection;
}>): PluginSelectedArtifactAdmission {
    const selected = input.daemonProjectionSelection;
    if (!selected) return input.reader.readCurrentArtifact(input.slot);
    if (
        !selected.occurrenceId.trim()
        || selected.artifact.pluginId !== input.slot.pluginId
        || selected.artifact.contributionId !== input.slot.contributionId
        || selected.artifact.tier !== input.slot.tier
        || selected.artifact.platform !== input.slot.platform
    ) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    try {
        if (!selected.isCurrent()) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
        }
    } catch {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
    }
    return Object.freeze({
        kind: 'available',
        artifact: selected.artifact,
    });
}

function sameArtifactIdentity(
    left: PluginSelectedArtifactIdentity,
    right: PluginSelectedArtifactAdmission,
): boolean {
    return right.kind === 'available'
        && left.pluginId === right.artifact.pluginId
        && left.contributionId === right.artifact.contributionId
        && left.artifactId === right.artifact.artifactId
        && left.tier === right.artifact.tier
        && left.platform === right.artifact.platform
        && left.digest === right.artifact.digest
        && left.hostUiApiRange === right.artifact.hostUiApiRange
        && left.releaseVersion === right.artifact.releaseVersion;
}

function isGraphCompatible(
    graph: PluginUiArtifactsManifestEntryV2,
    artifact: PluginSelectedArtifactIdentity,
): boolean {
    return graph.artifactId === artifact.artifactId
        && graph.tier === artifact.tier
        && graph.digest === artifact.digest
        && graph.hostUiApiRange === artifact.hostUiApiRange;
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
        SOURCE_ORDER.indexOf(left.kind) - SOURCE_ORDER.indexOf(right.kind)
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

type InFlightArtifactMaterializationParticipant = Readonly<{
    sources: readonly PluginArtifactSourceCandidate[];
    isCurrent: () => boolean;
    signal: AbortSignal;
    accountHostedArtifactId?: string;
}>;

type InFlightArtifactMaterialization = Readonly<{
    participants: Set<InFlightArtifactMaterializationParticipant>;
    promise: Promise<PluginArtifactVerifiedSourceResult>;
}>;

const sharedMaterializationsByLifetime = new WeakMap<
    object,
    Map<PluginUiArtifactDigestV1, InFlightArtifactMaterialization>
>();

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
    writePersistentArtifact: (
        record: PluginUiPersistentArtifactRecord,
    ) => Promise<PluginUiPersistentArtifactWriteDisposition | null>;
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
                if (!open || !isCurrent() || !areServerAccountScopesEqual(record.persistentIdentity.accountScope, input.scope)) return null;
                const key = artifactKey(record.persistentIdentity);
                await awaitRemoval(key);
                if (!open || !isCurrent()) return null;
                try {
                    const disposition = await store.write(clonePersistentArtifactRecord(record));
                    quarantinedKeys.delete(key);
                    return open && isCurrent() ? disposition : null;
                } catch {
                    options.onDiagnostic?.('plugin_ui_artifact_cache_write_failed');
                    return null;
                }
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
            try { return (await operation.writePersistentArtifact(record)) !== null; } finally { operation.release(); }
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
        artifactDigest: input.artifact.digest,
    });
}

/**
 * The device-cache byte source: the retained verified file set for the
 * selected digest inside this server/Account partition.
 */
export function createPluginArtifactPersistentSource(input: Readonly<{
    scope: PluginArtifactLeasePersistentScope;
}>): PluginArtifactSourceCandidate {
    let loadedIdentity: PluginUiPersistentArtifactIdentity | null = null;
    return Object.freeze({
        kind: 'persistentCache',
        fetch: async ({ artifact }) => {
            if (!input.scope.isCurrent()) return null;
            const identity = persistentIdentityFor({ scope: input.scope.scope, artifact });
            const record = await input.scope.store.read(identity).catch(() => null);
            if (!record || !input.scope.isCurrent()) return null;
            loadedIdentity = identity;
            return new Map(record.files.map((file) => [file.relativePath, new Uint8Array(file.bytes)] as const));
        },
        discardInvalid: async () => {
            const identity = loadedIdentity;
            loadedIdentity = null;
            if (identity && input.scope.isCurrent()) await input.scope.removePersistentArtifact(identity);
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
 * fetches each one's file set for the selected digest, and admits a source
 * only when each declared file and the complete file set pass canonical
 * integrity. It owns no lease,
 * lifetime, cache custody, or result vocabulary: callers keep their own
 * currentness owner and map the outcome to their own typed codes.
 */
export async function materializeVerifiedPluginArtifactSource(input: Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    graph: PluginUiArtifactsManifestEntryV2;
    /** Already ordered by the caller's admitted source order. */
    sources: readonly PluginArtifactSourceCandidate[];
    isCurrent: () => boolean;
    signal?: AbortSignal;
    /** Supplied only when the Account-hosted source needs its current link. */
    accountHostedArtifactId?: string;
}>): Promise<PluginArtifactVerifiedSourceResult> {
    const isCurrent = () => !input.signal?.aborted && input.isCurrent();
    let sawIntegrityFailure = false;
    for (const source of input.sources) {
        if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
        let fetched: PluginArtifactFileSet | null;
        try {
            fetched = await awaitArtifactWork(source.fetch({
                artifact: input.artifact,
                ...(input.signal ? { signal: input.signal } : {}),
                ...(input.accountHostedArtifactId
                    ? { accountHostedArtifactId: input.accountHostedArtifactId }
                    : {}),
            }), input.signal);
        } catch {
            fetched = null;
        }
        if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
        if (!fetched) continue;
        const materialized: PluginArtifactVerifiedSourceFile[] = [];
        let sourceUsable = true;
        for (const declared of input.graph.files) {
            const fetchedBytes = fetched.get(declared.relativePath);
            if (!fetchedBytes) {
                sourceUsable = false;
                break;
            }
            if (fetchedBytes.byteLength !== declared.byteSize) {
                sawIntegrityFailure = true;
                sourceUsable = false;
                break;
            }
            const bytes = new Uint8Array(fetchedBytes);
            const digest = await computePluginUiArtifactSha256Digest(bytes);
            if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
            if (digest !== declared.digest) {
                sawIntegrityFailure = true;
                sourceUsable = false;
                break;
            }
            materialized.push(Object.freeze({ file: cloneFile(declared), bytes }));
        }
        if (!sourceUsable) {
            await discardInvalidPersistentSource(source);
            continue;
        }
        const setDigest = await computePluginUiArtifactFileSetSha256Digest(
            materialized.map(({ file, bytes }) => ({ relativePath: file.relativePath, bytes })),
        );
        if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
        if (setDigest !== input.artifact.digest) {
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

/** A retired reader must settle even when a byte transport ignores cancellation. */
function awaitArtifactWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | null> {
    if (!signal) return work;
    let cancelled!: () => void;
    return new Promise<T | null>((resolve, reject) => {
        cancelled = () => resolve(null);
        if (signal.aborted) cancelled();
        else signal.addEventListener('abort', cancelled, { once: true });
        work.then(resolve, reject);
    }).finally(() => signal.removeEventListener('abort', cancelled));
}

function isInFlightArtifactParticipantCurrent(
    participant: InFlightArtifactMaterializationParticipant,
): boolean {
    try {
        return participant.isCurrent();
    } catch {
        return false;
    }
}

async function materializeInFlightVerifiedPluginArtifactSource(input: Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    graph: PluginUiArtifactsManifestEntryV2;
    participants: ReadonlySet<InFlightArtifactMaterializationParticipant>;
}>): Promise<PluginArtifactVerifiedSourceResult> {
    // Joined occurrences share verification work, not the first occurrence's
    // source ownership. Restart the canonical order after each failed/retired
    // candidate so a newly joined current participant can supply exact bytes.
    const attemptedByParticipant = new Map<
        InFlightArtifactMaterializationParticipant,
        Set<PluginArtifactSourceCandidate>
    >();
    let sawIntegrityFailure = false;

    while (true) {
        let next: Readonly<{
            participant: InFlightArtifactMaterializationParticipant;
            source: PluginArtifactSourceCandidate;
        }> | null = null;
        let anyCurrent = false;
        for (const kind of SOURCE_ORDER) {
            for (const participant of input.participants) {
                if (!isInFlightArtifactParticipantCurrent(participant)) continue;
                anyCurrent = true;
                const attempted = attemptedByParticipant.get(participant);
                const source = participant.sources.find((candidate) => (
                    candidate.kind === kind && !attempted?.has(candidate)
                ));
                if (source) {
                    next = Object.freeze({ participant, source });
                    break;
                }
            }
            if (next) break;
        }
        if (!anyCurrent) return Object.freeze({ kind: 'notCurrent' });
        if (!next) {
            return Object.freeze({ kind: 'unavailable', integrityFailed: sawIntegrityFailure });
        }

        let attempted = attemptedByParticipant.get(next.participant);
        if (!attempted) {
            attempted = new Set();
            attemptedByParticipant.set(next.participant, attempted);
        }
        attempted.add(next.source);
        const materialized = await materializeVerifiedPluginArtifactSource({
            artifact: input.artifact,
            graph: input.graph,
            sources: [next.source],
            isCurrent: next.participant.isCurrent,
            signal: next.participant.signal,
            ...(next.participant.accountHostedArtifactId
                ? { accountHostedArtifactId: next.participant.accountHostedArtifactId }
                : {}),
        });
        if (materialized.kind === 'available') return materialized;
        if (materialized.kind === 'unavailable' && materialized.integrityFailed) {
            sawIntegrityFailure = true;
        }
    }
}

function materializeSharedVerifiedPluginArtifactSource(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    acquisitionLifetime?: PluginArtifactLeaseAccountLifetime;
    artifact: PluginSelectedArtifactIdentity;
    graph: PluginUiArtifactsManifestEntryV2;
    sources: readonly PluginArtifactSourceCandidate[];
    isCurrent: () => boolean;
    signal: AbortSignal;
    accountHostedArtifactId?: string;
}>): Promise<PluginArtifactVerifiedSourceResult> {
    const lifetime = input.acquisitionLifetime ?? input.reader;
    let byDigest = sharedMaterializationsByLifetime.get(lifetime);
    if (!byDigest) {
        byDigest = new Map();
        sharedMaterializationsByLifetime.set(lifetime, byDigest);
        const retained = byDigest;
        let retirement: Readonly<{ dispose: () => void }> | undefined;
        retirement = input.acquisitionLifetime?.onRetire(() => {
            retirement?.dispose();
            retained.clear();
            sharedMaterializationsByLifetime.delete(lifetime);
        });
    }
    const participant: InFlightArtifactMaterializationParticipant = Object.freeze({
        sources: input.sources,
        isCurrent: input.isCurrent,
        signal: input.signal,
        ...(input.accountHostedArtifactId
            ? { accountHostedArtifactId: input.accountHostedArtifactId }
            : {}),
    });
    const existing = byDigest.get(input.artifact.digest);
    if (existing) {
        existing.participants.add(participant);
        return existing.promise;
    }

    const participants = new Set([participant]);
    const promise = materializeInFlightVerifiedPluginArtifactSource({
        artifact: input.artifact,
        graph: input.graph,
        participants,
    }).finally(() => {
        participants.clear();
        // Settled byte reuse belongs to the existing persistent/cache owner,
        // including its eviction policy. This map shares only active work.
        if (byDigest?.get(input.artifact.digest)?.promise === promise) {
            byDigest.delete(input.artifact.digest);
        }
    });
    byDigest.set(input.artifact.digest, Object.freeze({ participants, promise }));
    return promise;
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
/** The Account lifetime facts a lease needs: currentness and retirement. */
export type PluginArtifactLeaseAccountLifetime = Readonly<{
    isCurrent: () => boolean;
    onRetire: (listener: () => void) => Readonly<{ dispose: () => void }>;
}>;

export async function acquirePluginSelectedArtifactLease(input: Readonly<{
    reader: PluginAccountAvailabilityReader;
    /**
     * The one active Account lifetime. It is one of the lease's two
     * currentness facts and scopes in-flight digest sharing.
     */
    accountLifetime?: PluginArtifactLeaseAccountLifetime;
    /** This requesting surface's lifetime, independent of other joined readers. */
    signal?: AbortSignal;
    slot: PluginAccountAvailabilityArtifactSlot;
    daemonProjectionSelection?: PluginDaemonProjectionArtifactSelection;
    artifactGraph: unknown;
    sources: readonly PluginArtifactSourceCandidate[];
}>): Promise<PluginSelectedArtifactLeaseAcquireResult> {
    const admission = readSelectedArtifactAdmission(input);
    if (admission.kind !== 'available') {
        return Object.freeze({ kind: 'unavailable', code: admission.code });
    }
    const graph = PluginUiArtifactsManifestEntryV2Schema.safeParse(input.artifactGraph);
    if (!graph.success) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_graph_invalid' });
    }
    const artifact = cloneArtifactFact(admission.artifact);
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
    const cancellation = new AbortController();
    let unsubscribe: (() => void) | null = null;
    let retirement: Readonly<{ dispose: () => void }> | null = null;
    let revoked = false;
    const stopObserving = () => {
        input.signal?.removeEventListener('abort', revoke);
        unsubscribe?.();
        unsubscribe = null;
        retirement?.dispose();
        retirement = null;
    };
    const revoke = () => {
        if (revoked) return;
        revoked = true;
        cancellation.abort();
        stopObserving();
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
    // The lease's whole currentness: the Account lifetime and the current
    // per-plugin selection (Account release or daemon occurrence). Sources,
    // custody, and consumers add no further revocation layer.
    const lifetimeIsCurrent = () => {
        try {
            return input.accountLifetime ? input.accountLifetime.isCurrent() : true;
        } catch {
            return false;
        }
    };
    const isCurrent = () => {
        if (revoked) return false;
        if (input.signal?.aborted || !lifetimeIsCurrent() || !sameArtifactIdentity(artifact, readSelectedArtifactAdmission(input))) {
            revoke();
            return false;
        }
        return true;
    };
    unsubscribe = input.reader.subscribe(() => {
        isCurrent();
    });
    retirement = input.accountLifetime?.onRetire(revoke) ?? null;
    input.signal?.addEventListener('abort', revoke, { once: true });
    if (!isCurrent()) {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }

    const materializedSource = await awaitArtifactWork(materializeSharedVerifiedPluginArtifactSource({
        reader: input.reader,
        ...(input.accountLifetime ? { acquisitionLifetime: input.accountLifetime } : {}),
        artifact,
        graph: graph.data,
        sources,
        isCurrent,
        signal: cancellation.signal,
        ...(admission.artifact.accountArtifactId
            ? { accountHostedArtifactId: admission.artifact.accountArtifactId }
            : {}),
    }), cancellation.signal);
    if (!isCurrent() || !materializedSource || materializedSource.kind === 'notCurrent') {
        return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
    }
    if (materializedSource.kind === 'unavailable') {
        stopObserving();
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
    // Digest reuse never admits a contradictory graph supplied by another
    // occurrence. Check its declared metadata against the verified file set
    // without hashing or copying those immutable bytes again.
    if (
        graph.data.files.length !== materializedSource.files.length
        || new Set(graph.data.files.map((file) => file.relativePath)).size !== files.size
        || graph.data.files.some((declared) => {
            const verified = files.get(declared.relativePath)?.file;
            return verified?.digest !== declared.digest || verified.byteSize !== declared.byteSize;
        })
    ) {
        stopObserving();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
    }
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
