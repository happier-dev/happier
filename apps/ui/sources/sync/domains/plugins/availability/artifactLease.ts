import {
    PluginUiArtifactsManifestEntryV2Schema,
    type PluginUiArtifactArchiveOpenedV1,
    type PluginUiArtifactDigestV1,
    type PluginUiArtifactFileV1,
    type PluginUiArtifactsManifestEntryV2,
} from '@happier-dev/protocol/plugins/ui';
import { carryActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginAccountHostedArtifactPublicationResult } from './accountHostedArtifactPublication';
import {
    computePluginUiArtifactSha256Digest,
    computePluginUiArtifactFileSetSha256Digest,
} from '@/sync/domains/plugins/ui/artifactIntegrity';

import type {
    PluginAccountAvailabilityArtifactAdmission,
    PluginAccountAvailabilityArtifactFact,
    PluginAccountAvailabilityArtifactSlot,
    PluginAccountAvailabilityReader,
    PluginDaemonProjectionArtifactSelection,
} from './reader';
export type { PluginDaemonProjectionArtifactSelection } from './reader';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    derivePluginUiPersistentArtifactAccountKey,
    derivePluginUiPersistentArtifactKey,
} from '@/sync/domains/plugins/ui/artifactByteCache';
import type {
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

/** Safe byte-source refusals; private transport messages never leave the adapter. */
export type PluginArtifactSourceFailureCode =
    | 'artifact_bytes_rpc_unavailable'
    | 'artifact_bytes_response_invalid'
    | 'artifact_bytes_fetch_failed'
    | 'plugin_host_access_disclosure_mismatch'
    | 'transport_unavailable'
    | 'response_invalid';

export class PluginArtifactSourceError extends Error {
    constructor(readonly code: PluginArtifactSourceFailureCode, readonly reason?: string) {
        super(code);
        this.name = 'PluginArtifactSourceError';
    }
}

/**
 * The one byte-source interface. Every source (app preseed, device cache,
 * daemon, Account hosting) returns the complete file set for the requested
 * digest or `null` for a miss. Safe failures may throw PluginArtifactSourceError.
 * External bytes are verified once: by the lease for a raw file set, or by
 * the archive opener for an opened archive. App bytes and retained verified
 * bytes are internal data. The lease checks correspondence to the selected
 * graph; a source has no admission, selection, or currentness authority.
 */
export type PluginArtifactSourceCandidate = Readonly<{
    kind: PluginArtifactSourceKind;
    fetch: (request: PluginArtifactByteRequest) => Promise<
        PluginArtifactFileSet | PluginUiArtifactArchiveOpenedV1 | null
    >;
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
        code: 'artifact_file_not_declared' | 'artifact_lease_revoked' | 'artifact_lease_files_released';
    }>;

export type PluginSelectedArtifactLease = Readonly<{
    artifact: PluginSelectedArtifactIdentity;
    /** The one fully verified source that supplied this private handle. */
    sourceKind: PluginArtifactSourceKind;
    artifactGraph: PluginUiArtifactsManifestEntryV2;
    files: readonly PluginUiArtifactFileV1[];
    readFile: (relativePath: string) => Promise<PluginSelectedArtifactLeaseFileResult>;
    /**
     * The holder has copied what it needs. The lease drops its verified bytes;
     * currentness, revocation and dispose are unchanged.
     */
    releaseFiles: () => void;
    isCurrent: () => boolean;
    onRevoke: (listener: () => void) => Readonly<{ dispose: () => void }>;
    dispose: () => void;
}>;

export type PluginSelectedArtifactLeaseAcquireResult =
    | Readonly<{
        kind: 'available';
        lease: PluginSelectedArtifactLease;
        /** Optional hosting never delays use of the verified lease. */
        accountHosting?: Promise<PluginAccountHostedArtifactPublicationResult>;
    }>
    | Readonly<{
        kind: 'unavailable';
        code:
            | Extract<PluginAccountAvailabilityArtifactAdmission, { kind: 'unavailable' }>['code']
            | 'artifact_graph_invalid'
            | 'artifact_graph_mismatch'
            | 'artifact_source_ambiguous'
            | 'artifact_source_integrity_invalid'
            | 'artifact_source_unavailable'
            | 'artifact_lease_revoked'
            | PluginArtifactSourceFailureCode;
        diagnostics?: readonly string[];
    }>;

const SOURCE_ORDER = Object.freeze([
    'persistentCache',
    'appExact',
    'accountHosted',
    'daemon',
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
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
}>): PluginSelectedArtifactAdmission {
    return input.reader.readCurrentArtifact(input.slot, input.executionOrigin, input.daemonProjectionSelection);
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

/** Metadata correspondence between two graphs for the same digest; hashes nothing. */
function declaresSameFiles(
    declared: readonly PluginUiArtifactFileV1[],
    verified: readonly PluginUiArtifactFileV1[],
): boolean {
    const verifiedByPath = new Map(verified.map((file) => [file.relativePath, file] as const));
    return declared.length === verified.length
        && new Set(declared.map((file) => file.relativePath)).size === verifiedByPath.size
        && declared.every((file) => {
            const match = verifiedByPath.get(file.relativePath);
            return match?.digest === file.digest && match.byteSize === file.byteSize;
        });
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
    | Readonly<{ kind: 'unavailable'; integrityFailed: boolean; sourceFailure?: PluginArtifactSourceError }>;

type InFlightArtifactMaterializationParticipant = Readonly<{
    artifact: PluginSelectedArtifactIdentity;
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

export { persistVerifiedPluginArtifactLease } from './persistVerifiedArtifact';

/**
 * The one verified-source materializer. It walks already-ordered candidates,
 * fetches each one's file set for the selected digest, and admits a source
 * only when its declared files are present. Raw Home/daemon ingress passes
 * canonical integrity here; app bytes and previously verified device bytes
 * need no per-load hashing. It owns no lease,
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
    let sourceFailure: PluginArtifactSourceError | undefined;
    for (const source of input.sources) {
        if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
        let fetched: Awaited<ReturnType<PluginArtifactSourceCandidate['fetch']>>;
        try {
            fetched = await awaitArtifactWork(source.fetch({
                artifact: input.artifact,
                ...(input.signal ? { signal: input.signal } : {}),
                ...(input.accountHostedArtifactId
                    ? { accountHostedArtifactId: input.accountHostedArtifactId }
                    : {}),
            }), input.signal);
        } catch (error) {
            if (error instanceof PluginArtifactSourceError) sourceFailure ??= error;
            fetched = null;
        }
        if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
        if (!fetched) continue;
        if ('artifactGraph' in fetched) {
            if (
                fetched.artifactGraph.digest !== input.artifact.digest
                || !declaresSameFiles(input.graph.files, fetched.artifactGraph.files)
            ) {
                sawIntegrityFailure = true;
                continue;
            }
            const { files } = fetched;
            return Object.freeze({
                kind: 'available',
                source,
                files: Object.freeze(input.graph.files.map((declared) => Object.freeze({
                    file: cloneFile(declared),
                    bytes: files.get(declared.relativePath)!,
                }))),
            });
        }
        const verifyIngress = source.kind === 'accountHosted' || source.kind === 'daemon';
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
            if (verifyIngress) {
                const digest = await computePluginUiArtifactSha256Digest(bytes);
                if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
                if (digest !== declared.digest) {
                    sawIntegrityFailure = true;
                    sourceUsable = false;
                    break;
                }
            }
            materialized.push(Object.freeze({ file: cloneFile(declared), bytes }));
        }
        if (!sourceUsable) {
            await discardInvalidPersistentSource(source);
            continue;
        }
        if (verifyIngress) {
            const setDigest = await computePluginUiArtifactFileSetSha256Digest(
                materialized.map(({ file, bytes }) => ({ relativePath: file.relativePath, bytes })),
            );
            if (!isCurrent()) return Object.freeze({ kind: 'notCurrent' });
            if (setDigest !== input.artifact.digest) {
                sawIntegrityFailure = true;
                await discardInvalidPersistentSource(source);
                continue;
            }
        }
        return Object.freeze({
            kind: 'available',
            source,
            files: Object.freeze(materialized),
        });
    }
    return Object.freeze({
        kind: 'unavailable',
        integrityFailed: sawIntegrityFailure,
        ...(sourceFailure ? { sourceFailure } : {}),
    });
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
    let sourceFailure: PluginArtifactSourceError | undefined;

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
            return Object.freeze({
                kind: 'unavailable',
                integrityFailed: sawIntegrityFailure,
                ...(sourceFailure ? { sourceFailure } : {}),
            });
        }

        let attempted = attemptedByParticipant.get(next.participant);
        if (!attempted) {
            attempted = new Set();
            attemptedByParticipant.set(next.participant, attempted);
        }
        attempted.add(next.source);
        const materialized = await materializeVerifiedPluginArtifactSource({
            artifact: next.participant.artifact,
            graph: input.graph,
            sources: [next.source],
            isCurrent: next.participant.isCurrent,
            signal: next.participant.signal,
            ...(next.participant.accountHostedArtifactId
                ? { accountHostedArtifactId: next.participant.accountHostedArtifactId }
                : {}),
        });
        if (materialized.kind === 'available') return materialized;
        if (materialized.kind === 'unavailable') {
            sawIntegrityFailure ||= materialized.integrityFailed;
            sourceFailure ??= materialized.sourceFailure;
        }
    }
}

// Its own scope: the Account-lived retirement listener must not capture a
// call's settled promise, which holds that Artifact's verified bytes.
function readSharedMaterializations(lifetime: object, acquisitionLifetime: PluginArtifactLeaseAccountLifetime | undefined) {
    const existing = sharedMaterializationsByLifetime.get(lifetime);
    if (existing) return existing;
    const byDigest = new Map<PluginUiArtifactDigestV1, InFlightArtifactMaterialization>();
    sharedMaterializationsByLifetime.set(lifetime, byDigest);
    let retirement: Readonly<{ dispose: () => void }> | undefined;
    retirement = acquisitionLifetime?.onRetire(() => {
        retirement?.dispose();
        byDigest.clear();
        sharedMaterializationsByLifetime.delete(lifetime);
    });
    return byDigest;
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
    const byDigest = readSharedMaterializations(input.acquisitionLifetime ?? input.reader, input.acquisitionLifetime);
    const participant: InFlightArtifactMaterializationParticipant = Object.freeze({
        artifact: input.artifact,
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
        graph: input.graph,
        participants,
    }).finally(() => {
        participants.clear();
        // Settled byte reuse belongs to the existing persistent/cache owner,
        // including its eviction policy. This map shares only active work.
        if (byDigest.get(input.artifact.digest)?.promise === promise) {
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
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
    artifactGraph: unknown;
    sources: readonly PluginArtifactSourceCandidate[];
}>): Promise<PluginSelectedArtifactLeaseAcquireResult> {
    type Admission = PluginSelectedArtifactAdmission | Readonly<{ kind: 'unavailable'; code: 'artifact_lease_revoked' }>;
    let admission: Admission = readSelectedArtifactAdmission(input);
    // An initial/restored Account projection is asynchronous readiness, not an
    // executable Artifact failure. Wait through the existing projection and
    // Account lifetime; no bytes are admitted until selection is established.
    if (admission.kind === 'unavailable' && admission.code === 'account_availability_not_loaded'
        && (input.accountLifetime || input.signal)) {
        admission = await new Promise<Admission>((resolve) => {
            let settled = false;
            let unsubscribe: (() => void) | undefined;
            let retirement: Readonly<{ dispose(): void }> | undefined;
            const cleanup = () => {
                unsubscribe?.();
                retirement?.dispose();
                input.signal?.removeEventListener('abort', observe);
            };
            const observe = () => {
                if (settled) return;
                const current = input.signal?.aborted || input.accountLifetime?.isCurrent() === false
                    ? Object.freeze({ kind: 'unavailable' as const, code: 'artifact_lease_revoked' as const })
                    : readSelectedArtifactAdmission(input);
                if (current.kind === 'unavailable' && current.code === 'account_availability_not_loaded') return;
                settled = true;
                cleanup();
                resolve(current);
            };
            unsubscribe = input.reader.subscribe(observe);
            retirement = input.accountLifetime?.onRetire(observe);
            input.signal?.addEventListener('abort', observe, { once: true });
            observe();
            // onRetire may synchronously observe an already-retired lifetime.
            if (settled) cleanup();
        });
    }
    if (admission.kind !== 'available') {
        return Object.freeze(carryActionFailureDiagnostic({ kind: 'unavailable' as const, code: admission.code }, admission));
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
        if (materializedSource.integrityFailed) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
        }
        const failure = materializedSource.sourceFailure;
        return Object.freeze({
            kind: 'unavailable',
            code: failure?.code ?? 'artifact_source_unavailable',
            ...(failure?.reason ? { diagnostics: Object.freeze([failure.code, failure.reason]) } : {}),
        });
    }
    // Revocation closures share this scope, so the bytes are held only through
    // this binding, which `releaseFiles` clears once the holder has its copy.
    let files: ReadonlyMap<string, Readonly<{ file: PluginUiArtifactFileV1; bytes: Uint8Array }>> | null = new Map(
        materializedSource.files.map(({ file, bytes }) => [file.relativePath, { file, bytes }] as const),
    );
    // Digest reuse never admits a contradictory graph supplied by another
    // occurrence. Check its declared metadata against the verified file set
    // without hashing or copying those immutable bytes again.
    if (!declaresSameFiles(graph.data.files, materializedSource.files.map(({ file }) => file))) {
        stopObserving();
        return Object.freeze({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
    }
    const readFile = async (relativePath: string): Promise<PluginSelectedArtifactLeaseFileResult> => {
        if (!isCurrent()) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        }
        if (!files) {
            return Object.freeze({ kind: 'unavailable', code: 'artifact_lease_files_released' });
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
            releaseFiles: () => { files = null; },
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
