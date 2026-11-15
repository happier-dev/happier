import { readAccountE2eeCustody, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { admitMachineRowPlainMode } from '@happier-dev/sync-client';
import { log } from '@/log';
import type { Machine, MachineLockedReason } from '@/sync/domains/state/storageTypes';
import { serverFetch, StaleServerGenerationError } from '@/sync/http/client';
import { createTaskLimiter } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { buildMachineDisplayRenderableFromMachine, type MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { MachineKindFromLegacyProjectionSchema } from '@happier-dev/protocol/machines/machineKind';
import { MachineOperationProtocolCapabilitiesV1StoredReadSchema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { decodePlainMachineStoredContent, isPlainMachineDataKeyMarker, resolvePublishedMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { resolveRunnerMachineContentKeyTrustV1 } from '@/sync/domains/machines/runnerMachineContentKeyTrust';
import type { MachineEncryptionContext, MachineEncryptionContextInput } from '@/sync/encryption/encryption';
import { readMachineEncryptionContextInput } from '@/sync/encryption/machineEncryption';
import { isDataKeyOpeningCancelled } from '@/sync/encryption/dataKeyOpenings';
import { parseToken } from '@/utils/auth/parseToken';
import { AccessibleMachineAccessStoredReadV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { StoredMachinePublishedMetadataV1Schema, StoredMachinePublishedDaemonStateV1Schema, projectMachinePublishedMetadataFromRowV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { DevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { encodeBase64 } from '@/encryption/base64';
import { yieldToEventLoop } from '@/sync/encryption/cryptoBatchYield';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { hasCurrentMachineContent } from '@/sync/domains/machines/resolveServerScopedMachines';
import { readMachineCensus, readMachineRows } from '@/sync/api/machines/machineRowsApi';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isMachineActivityPlaceholder, readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { areStoredMachineSemanticsEqual, haveSameMachineContentAuthority } from '@/sync/store/domains/areStoredMachinesEqual';
import { createHydrationPublication } from './hydrationPublication';

type MachineEncryption = {
    decryptMetadata: (version: number, value: string) => Promise<any>;
    decryptDaemonState: (version: number, value: string) => Promise<any>;
};

type SyncEncryption = {
    decryptEncryptionKeys: (values: readonly string[]) => Promise<Array<Uint8Array | null>>;
    initializeMachines: (machineKeysMap: Map<string, Uint8Array | null>, unavailableMachineIds?: ReadonlySet<string>, options?: Readonly<{ isMachineCurrent?: (machineId: string) => boolean }>) => Promise<void>;
    getMachineEncryption: (machineId: string) => MachineEncryption | null;
    captureMachineEncryptionContext: (machineId: string, input: MachineEncryptionContextInput) => MachineEncryptionContext;
    captureMachineEncryptionContextRead: () => (machineId: string) => boolean;
};

/**
 * An unwrapped machine data key together with the exact wrapped envelope it came from.
 *
 * Carrying the envelope with the key is what makes the cache safe to read: a refresh may
 * reuse a plaintext key only when the server still reports the same envelope, so a
 * rotated key is never missed and no machine is left holding a key it no longer uses.
 * Keeping the two in one entry makes "a key whose source envelope is unknown"
 * unrepresentable.
 */
export type MachineDataKeyCacheEntry = Readonly<{
    envelope: string;
    dataKey: Uint8Array;
}>;

type MachineIdentityFields = Pick<
    Machine,
    | 'kind'
    | 'presenceProtocolVersion'
    | 'replacedByMachineId'
    | 'replacedAt'
    | 'replacementReason'
    | 'replacementSource'
    | 'replacementActorUserId'
    | 'installationId'
    | 'installationPublicKey'
    | 'contentPublicKeyFingerprint'
    | 'operationProtocolCapabilities'
    | 'operationProtocolCapabilitiesRevision'
>;

type MachineIdentityFieldSource = Readonly<Partial<Omit<MachineIdentityFields, 'operationProtocolCapabilities'>> & {
    operationProtocolCapabilities?: unknown;
}>;

export type FetchedMachineRow = Readonly<{
    id: string;
    managedMachineRef?: Machine['managedMachineRef'];
    managedInputRuntime?: Machine['managedInputRuntime'];
    devcontainerChild?: DevcontainerChildProjectionV1 | null;
    kind?: Machine['kind'];
    metadata: string | null;
    metadataVersion: number;
    daemonState?: string | null;
    daemonStateVersion?: number;
    dataEncryptionKey?: string | null;
    keyBasis?: Machine['keyBasis'];
    access?: Machine['access'];
    isShared?: boolean;
    recipientWorkPending?: boolean;
    recipientWorkCursor?: number;
    storageMode?: Machine['storageMode'];
    runnerContentKeyBinding?: unknown;
    seq: number;
    active: boolean;
    activeAt: number;
    presenceProtocolVersion?: 1;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    replacedAt?: number | string | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
    installationId?: string | null;
    installationPublicKey?: string | null;
    contentPublicKeyFingerprint?: string | null;
    operationProtocolCapabilities?: unknown;
    operationProtocolCapabilitiesRevision?: number | null;
    createdAt: number;
    updatedAt: number;
}>;

export async function fetchMachineRows(params: Readonly<{
    credentials: AuthCredentials;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    readTransport?: CapturedServerReadTransport;
    signal?: AbortSignal;
    fresh?: boolean;
}>): Promise<readonly FetchedMachineRow[]> {
    const request =
        params.request
        ?? ((path: string, init: RequestInit) =>
            serverFetch(path, init, { includeAuth: false }));
    // Sync also supplies retained Session/recent-path replacement identity. The
    // visible Machine selectors still exclude revoked rows from discovery.
    return readMachineCensus({ request, readTransport: params.readTransport, signal: params.signal, fresh: params.fresh,
        headers: {
            'Authorization': `Bearer ${params.credentials.token}`,
            'Content-Type': 'application/json',
        },
    });
}

function readMachineIdentityFields(source: MachineIdentityFieldSource): MachineIdentityFields {
    const installationPublicKey = readMachineInstallationPublicKey(source.installationPublicKey);
    const capabilities = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(source.operationProtocolCapabilities);
    const revision = source.operationProtocolCapabilitiesRevision;
    const accepted = capabilities.success && typeof revision === 'number' && Number.isInteger(revision) && revision > 0;
    return {
        kind: MachineKindFromLegacyProjectionSchema.parse(source.kind),
        ...(source.presenceProtocolVersion === 1 ? { presenceProtocolVersion: 1 as const } : {}),
        replacedByMachineId: source.replacedByMachineId ?? null,
        replacedAt: source.replacedAt ?? null,
        replacementReason: source.replacementReason ?? null,
        replacementSource: source.replacementSource ?? null,
        replacementActorUserId: source.replacementActorUserId ?? null,
        installationId: source.installationId ?? null,
        installationPublicKey: installationPublicKey ? encodeBase64(installationPublicKey, 'base64') : null,
        contentPublicKeyFingerprint: source.contentPublicKeyFingerprint ?? null,
        operationProtocolCapabilities: accepted ? capabilities.data : null,
        operationProtocolCapabilitiesRevision: accepted ? revision : null,
    };
}

function readMachinePublishedContext(machine: FetchedMachineRow) {
    return {
        ...(machine.managedMachineRef !== undefined ? { managedMachineRef: machine.managedMachineRef } : {}),
        ...(machine.managedInputRuntime !== undefined ? { managedInputRuntime: machine.managedInputRuntime } : {}),
        dataEncryptionKey: machine.dataEncryptionKey ?? null,
        ...(machine.keyBasis !== undefined ? { keyBasis: machine.keyBasis } : {}),
        ...(machine.access !== undefined ? { access: machine.access } : {}),
        ...(machine.isShared !== undefined ? { isShared: machine.isShared } : {}),
    };
}

/**
 * A hydrating row's daemon-state version names the daemon state it holds opened. Before an encrypted
 * daemon state opens, the display shell holds none: the published revision stays a hint (`keyBasis`)
 * instead of claiming that version, so opening its metadata and then its daemon state only ever
 * advances the version. Locked views keep the authoritative revision; nothing opens under them.
 */
function readUnopenedDaemonStateVersion(machine: FetchedMachineRow): number {
    return typeof machine.daemonState === 'string' && machine.daemonState.length > 0 ? 0 : machine.daemonStateVersion ?? 0;
}

function createLockedMachineView(
    machine: FetchedMachineRow,
    reason: MachineLockedReason,
    storageMode: 'plain' | 'e2ee' = 'e2ee',
    _previous?: Machine | null,
): Machine {
    return {
        id: machine.id,
        seq: machine.seq,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        metadata: null,
        metadataVersion: machine.metadataVersion,
        daemonState: null,
        daemonStateVersion: machine.daemonStateVersion ?? 0,
        ...readMachineIdentityFields(machine),
        ...readMachinePublishedContext(machine),
        storageMode,
        availability: {
            kind: 'locked',
            reason,
        },
    };
}

function createReadablePlainMachineView(machine: FetchedMachineRow, previous?: Machine | null): Machine {
    // Versions identify already admitted content, not access. Callers resolve
    // the current mode/key/access first; absent content still withdraws a field.
    const canReuse = previous?.storageMode === 'plain' && canRetainOpenedMachineContent(machine, previous);
    let metadata = machine.metadata && canReuse && previous.metadataVersion === machine.metadataVersion
        ? previous.metadata : null;
    if (machine.metadata && !metadata) {
        const parsed = StoredMachinePublishedMetadataV1Schema.safeParse(decodePlainMachineStoredContent(machine.metadata));
        metadata = parsed.success ? parsed.data : null;
    }
    if (!metadata) return createLockedMachineView(machine, 'content_unreadable', 'plain', previous);
    let daemonState = machine.daemonState && canReuse && previous.daemonStateVersion === (machine.daemonStateVersion ?? 0)
        ? previous.daemonState : null;
    if (machine.daemonState && daemonState == null) {
        const parsed = StoredMachinePublishedDaemonStateV1Schema.safeParse(decodePlainMachineStoredContent(machine.daemonState));
        daemonState = parsed.success ? parsed.data : null;
    }
    return {
        id: machine.id,
        seq: machine.seq,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        metadata: projectMachinePublishedMetadataFromRowV1(metadata, machine.devcontainerChild),
        metadataVersion: machine.metadataVersion,
        daemonState,
        daemonStateVersion: machine.daemonStateVersion ?? 0,
        storageMode: 'plain',
        availability: { kind: 'available' },
        ...readMachineIdentityFields(machine),
        ...readMachinePublishedContext(machine),
    };
}

/** Same-key pending content retains presentation, never fresh execution authority. */
function canRetainOpenedMachineContent(machine: Parameters<typeof haveSameMachineContentAuthority>[0], incumbent: Machine | null | undefined): boolean {
    return incumbent?.availability?.kind === 'available'
        && haveSameMachineContentAuthority(incumbent, machine);
}

const warnedMachineDataEncryptionKeyFailuresByEncryption = new WeakMap<SyncEncryption, Set<string>>();

function warnMachineDataEncryptionKeyDecryptFailureOnce(encryption: SyncEncryption, machineId: string): void {
    let warnedMachineIds = warnedMachineDataEncryptionKeyFailuresByEncryption.get(encryption);
    if (!warnedMachineIds) {
        warnedMachineIds = new Set<string>();
        warnedMachineDataEncryptionKeyFailuresByEncryption.set(encryption, warnedMachineIds);
    }
    if (warnedMachineIds.has(machineId)) return;
    warnedMachineIds.add(machineId);
    console.warn(`Failed to decrypt data encryption key for machine ${machineId}; machine encryption is unavailable.`);
}

export async function buildUpdatedMachineFromSocketUpdate(params: {
    machineUpdate: any;
    updateSeq: number;
    updateCreatedAt: number;
    existingMachine: Machine | undefined;
    keyBasis?: Machine['keyBasis'];
    getMachineEncryption: (machineId: string) => MachineEncryption | null | undefined;
}): Promise<Machine | null> {
    const { machineUpdate, updateCreatedAt, existingMachine, getMachineEncryption } = params;
    const existingActivity = existingMachine ? readMachineActivity(existingMachine) : null;

    const machineId = machineUpdate.machineId; // Changed from .id to .machineId

    const nextRevokedAt = (() => {
        const revokedAt = machineUpdate.revokedAt;
        if (revokedAt === null) return null;
        if (typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0) return revokedAt;
        return existingMachine?.revokedAt ?? null;
    })();

    // Create or update machine with all required fields
    const updatedMachine: Machine = {
        id: machineId,
        ...(machineUpdate.managedMachineRef !== undefined ? { managedMachineRef: machineUpdate.managedMachineRef }
            : existingMachine?.managedMachineRef !== undefined ? { managedMachineRef: existingMachine.managedMachineRef } : {}),
        ...(machineUpdate.managedInputRuntime !== undefined ? { managedInputRuntime: machineUpdate.managedInputRuntime }
            : existingMachine?.managedInputRuntime !== undefined ? { managedInputRuntime: existingMachine.managedInputRuntime } : {}),
        // IMPORTANT: socket UpdateContainer.seq is an account cursor, not the machine entity seq.
        seq: existingMachine?.seq ?? 0,
        createdAt: existingMachine?.createdAt ?? updateCreatedAt,
        updatedAt: updateCreatedAt,
        active: nextRevokedAt ? false : (machineUpdate.active ?? existingActivity?.active ?? false),
        activeAt: machineUpdate.activeAt ?? existingActivity?.activeAt ?? updateCreatedAt,
        revokedAt: nextRevokedAt,
        metadata: existingMachine?.metadata ?? null,
        metadataVersion: existingMachine?.metadataVersion ?? 0,
        daemonState: existingMachine?.daemonState ?? null,
        daemonStateVersion: existingMachine?.daemonStateVersion ?? 0,
        ...readMachineIdentityFields({
            ...existingMachine,
            ...machineUpdate,
        }),
        ...(existingMachine?.storageMode ? { storageMode: existingMachine.storageMode } : {}),
        ...(existingMachine?.availability ? { availability: existingMachine.availability } : {}),
        ...(existingMachine?.access ? { access: existingMachine.access } : {}),
        ...(existingMachine?.isShared !== undefined ? { isShared: existingMachine.isShared } : {}),
        ...(existingMachine?.keyBasis !== undefined ? { keyBasis: existingMachine.keyBasis } : {}),
        ...(params.keyBasis !== undefined ? { keyBasis: params.keyBasis } : {}),
        ...(existingMachine?.dataEncryptionKey !== undefined ? { dataEncryptionKey: existingMachine.dataEncryptionKey } : {}),
    };
    // Content patches do not republish the capability projection. Re-parsing
    // its retained object would look like an identity change to in-flight reads.
    if (existingMachine && !('operationProtocolCapabilities' in machineUpdate)
        && !('operationProtocolCapabilitiesRevision' in machineUpdate)) {
        updatedMachine.operationProtocolCapabilities = existingMachine.operationProtocolCapabilities;
        updatedMachine.operationProtocolCapabilitiesRevision = existingMachine.operationProtocolCapabilitiesRevision;
    }

    // Socket content never widens the current access projection; list refresh owns access changes.
    if (existingMachine?.isShared && existingMachine.access?.accessState !== 'ready') return updatedMachine;
    const projectChildFact = () => {
        if (machineUpdate.devcontainerChild !== undefined
            || (machineUpdate.metadata && machineUpdate.metadata.version > (existingMachine?.metadataVersion ?? 0))) {
            updatedMachine.metadata = projectMachinePublishedMetadataFromRowV1(updatedMachine.metadata, machineUpdate.devcontainerChild);
        }
    };
    const qualifyOpenedContent = () => {
        if (updatedMachine.metadata && updatedMachine.availability?.kind !== 'locked') {
            // Availability retains opened presentation; the inventory owner's
            // current-content check separately admits fresh execution.
            const retainedAdmission = canRetainOpenedMachineContent(updatedMachine, existingMachine);
            updatedMachine.availability = hasCurrentMachineContent(updatedMachine) || retainedAdmission
                ? { kind: 'available' } : undefined;
        }
    };

    if (existingMachine?.storageMode === 'plain') {
        let contentUnreadable = false;
        const metadataUpdate = machineUpdate.metadata;
        if (
            metadataUpdate
            && typeof metadataUpdate.version === 'number'
            && metadataUpdate.version > (existingMachine.metadataVersion ?? 0)
        ) {
            try {
                const parsed = StoredMachinePublishedMetadataV1Schema.safeParse(decodePlainMachineStoredContent(metadataUpdate.value));
                updatedMachine.metadata = parsed.success ? parsed.data : null;
                if (!parsed.success) contentUnreadable = true;
                updatedMachine.metadataVersion = metadataUpdate.version;
            } catch (error) {
                contentUnreadable = true;
                console.error(`Failed to read plaintext machine metadata for ${machineId}:`, error);
            }
        }
        const daemonStateUpdate = machineUpdate.daemonState;
        if (
            daemonStateUpdate
            && typeof daemonStateUpdate.version === 'number'
            && daemonStateUpdate.version > existingMachine.daemonStateVersion
        ) {
            try {
                const parsed = StoredMachinePublishedDaemonStateV1Schema.safeParse(decodePlainMachineStoredContent(daemonStateUpdate.value));
                updatedMachine.daemonState = parsed.success ? parsed.data : null;
                updatedMachine.daemonStateVersion = daemonStateUpdate.version;
            } catch (error) {
                contentUnreadable = true;
                console.error(`Failed to read plaintext machine daemon state for ${machineId}:`, error);
            }
        }
        if (contentUnreadable) {
            updatedMachine.availability = {
                kind: 'locked',
                reason: 'content_unreadable',
            };
        }
        projectChildFact();
        qualifyOpenedContent();
        return updatedMachine;
    }

    // Get machine-specific encryption (might not exist if machine wasn't initialized).
    // We still preserve freshness fields without it so the UI can reflect the
    // latest online/active state while a full machine refresh is pending.
    const machineEncryption = getMachineEncryption(machineId);
    if (!machineEncryption) {
        if (!machineUpdate.metadata) projectChildFact();
        qualifyOpenedContent();
        return updatedMachine;
    }

    // If metadata is provided, decrypt and update it
    const metadataUpdate = machineUpdate.metadata;
    if (metadataUpdate) {
        const existingVersion = existingMachine?.metadataVersion ?? 0;
        if (typeof metadataUpdate.version === 'number' && metadataUpdate.version <= existingVersion) {
            // Ignore stale/out-of-order update
        } else {
            try {
                const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
                updatedMachine.metadata = metadata;
                updatedMachine.metadataVersion = metadataUpdate.version;
            } catch (error) {
                console.error(`Failed to decrypt machine metadata for ${machineId}:`, error);
            }
        }
    }

    // If daemonState is provided, decrypt and update it
    const daemonStateUpdate = machineUpdate.daemonState;
    if (daemonStateUpdate) {
        const existingVersion = existingMachine?.daemonStateVersion ?? 0;
        if (typeof daemonStateUpdate.version === 'number' && daemonStateUpdate.version <= existingVersion) {
            // Ignore stale/out-of-order update
        } else {
            try {
                const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
                updatedMachine.daemonState = daemonState;
                updatedMachine.daemonStateVersion = daemonStateUpdate.version;
            } catch (error) {
                console.error(`Failed to decrypt machine daemonState for ${machineId}:`, error);
            }
        }
    }

    projectChildFact();
    if (getMachineEncryption(machineId) !== machineEncryption) return null;
    qualifyOpenedContent();
    return updatedMachine;
}

/** Presence and same-key version hints cannot retire a captured content/access read. */
function isMachineReadSnapshotCurrent(
    current: Machine | null | undefined,
    captured: Machine | null | undefined,
): boolean {
    if (current === captured) return true;
    if (!current) return false;
    if (!captured) {
        return isMachineActivityPlaceholder(current);
    }
    return Object.keys(current).length === Object.keys(captured).length
        && Object.entries(current).every(([key, value]) => {
            if (key === 'active' || key === 'activeAt' || key === 'updatedAt') return true;
            // Socket hints replace the basis object as published versions advance.
            // Only its key identity retires this read; hydration still withholds
            // execution until both opened fields satisfy the latest version hints.
            if (key === 'keyBasis') return current.keyBasis?.dataEncryptionKey === captured.keyBasis?.dataEncryptionKey;
            return value === captured[key as keyof Machine];
        });
}

/** Opened socket content can advance one field while the list opens the other. */
function isMachineHydrationSnapshotCurrent(current: Machine | null, captured: Machine | null | undefined): boolean {
    if (isMachineReadSnapshotCurrent(current, captured)) return true;
    if (!current || !captured || current.availability?.kind === 'locked'
        || current.metadataVersion < captured.metadataVersion || current.daemonStateVersion < captured.daemonStateVersion) return false;
    return Object.keys({ ...captured, ...current }).every(key => {
        if (key === 'active' || key === 'activeAt' || key === 'updatedAt'
            || key === 'metadata' || key === 'metadataVersion' || key === 'daemonState' || key === 'daemonStateVersion') return true;
        if (key === 'availability') return current.availability?.kind === 'available' || current.availability === captured.availability;
        if (key === 'keyBasis') return current.keyBasis?.dataEncryptionKey === captured.keyBasis?.dataEncryptionKey;
        return current[key as keyof Machine] === captured[key as keyof Machine];
    });
}

export async function fetchAndApplyMachines(params: {
    credentials: AuthCredentials;
    /** A named push refreshes these rows through the existing captured exact reader. */
    machineIds?: readonly string[];
    /** Persisted custodian Account mode for owner rows without an access projection. */
    expectedAccountMode?: 'plain' | 'e2ee';
    readAccountMode?: () => Promise<'plain' | 'e2ee'>;
    encryption: SyncEncryption | null;
    machineDataKeys: Map<string, MachineDataKeyCacheEntry>;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    readTransport?: CapturedServerReadTransport;
    signal?: AbortSignal;
    /** Accepted raw rows carry the published key/content basis beside hydrated display rows. */
    applyMachines: (machines: Machine[], replace: boolean, publishedRows: readonly FetchedMachineRow[]) => void;
    /** One admitted census, independently of warm and display-hydration publications. */
    onRowsObserved?: (machines: readonly FetchedMachineRow[]) => void;
    getExistingMachine?: (machineId: string) => Machine | null | undefined;
    /** Canonical immutable rows also fence keyless Plain/access reads before HTTP yields. */
    getMachineSnapshot?: () => Readonly<Record<string, Machine | undefined>>;
    applyMachineDisplayEntries?: (machines: MachineDisplayRenderable[], options?: { replace?: boolean }) => void;
    getCachedMachineDisplayEntry?: (machineId: string) => MachineDisplayCacheEntryV1 | undefined;
    machineDisplayHydrationConcurrencyLimit?: number;
    shouldContinue?: () => boolean;
    /**
     * Called when the machine list itself could not be read (transport failure or a non-OK
     * response), so the list owner can end its loading state instead of waiting forever.
     */
    onListUnavailable?: (error: unknown) => void;
    /** Called after the complete list is published, including display-first hydration. */
    onListComplete?: () => void;
    /**
     * When true, publish a complete inventory replacement only while its
     * captured membership is current; omission can mean withdrawn access.
     *
     * Defaults to false to keep machine lists stable during transient server
     * inconsistencies (SWR-style) and to avoid confusing UI flicker.
     */
    replace?: boolean;
    /** Exact Home identity for creator-authenticated Runner Machine key proof. */
    sourceServerId?: string | null;
    /**
     * When true, propagate network/HTTP/parse failures to the caller.
     *
     * Defaults to false so callers can use SWR-style refresh semantics without
     * spurious error surfaces.
     */
    throwOnError?: boolean;
}): Promise<void> {
    if (params.machineIds?.length === 0) return;
    const { credentials, encryption, machineDataKeys, applyMachines } = params;
    let viewerAccountId: string | null = null;
    try { viewerAccountId = parseToken(credentials.token); } catch { /* Historical token-only Plain reads need no content key. */ }
    const observePresence = captureMachinePresenceObservation(createServerAccountScope(params.sourceServerId, viewerAccountId));
    const concurrencyLimit = Math.max(1, Math.trunc(params.machineDisplayHydrationConcurrencyLimit ?? 4));
    const shouldContinue = params.shouldContinue ?? (() => true);
    const throwOnError = params.throwOnError === true;
    const isRequestMachineContextCurrent = encryption?.captureMachineEncryptionContextRead();
    const requestMachineSnapshot = params.getMachineSnapshot?.();
    const isCensusMembershipCurrent = () => !requestMachineSnapshot || !params.getMachineSnapshot
        || Object.entries(params.getMachineSnapshot()).every(([id, machine]) =>
            isMachineReadSnapshotCurrent(machine, incumbentRows.get(id) ?? requestMachineSnapshot[id]));

    let machines: readonly FetchedMachineRow[];
    let completeCensus = true;
    let expectedAccountMode = params.expectedAccountMode;
    try {
        // New/unknown discovery still uses the persistent-only census. Exact
        // selection also admits Session runners and must not broaden discovery.
        const knownSelection = params.machineIds?.every(id => requestMachineSnapshot?.[id] ?? params.getExistingMachine?.(id));
        const selected = knownSelection && params.machineIds && params.readTransport ? await readMachineRows({
            machineIds: params.machineIds, readTransport: params.readTransport, signal: params.signal,
        }) : undefined;
        // The exact wire also serves key-preparation readers with sparse rows.
        // Inventory publication needs the complete liveness/identity carriers.
        const selectedRows = selected && [...selected.values()].flatMap(row => row
            && typeof row.seq === 'number' && typeof row.active === 'boolean' && typeof row.activeAt === 'number'
            && typeof row.createdAt === 'number' && typeof row.updatedAt === 'number'
            ? [{ ...row, seq: row.seq, active: row.active, activeAt: row.activeAt, createdAt: row.createdAt, updatedAt: row.updatedAt }]
            : []);
        // Only a complete current census owns withdrawal by omission. Keep that
        // recovery for an absent/inaccessible row; ordinary named changes patch.
        completeCensus = !selectedRows || selectedRows.length !== selected!.size;
        machines = completeCensus ? await fetchMachineRows({
            credentials,
            ...(params.request ? { request: params.request } : {}),
            readTransport: params.readTransport,
            signal: params.signal,
        }) : selectedRows!;
        if (expectedAccountMode === undefined && params.readAccountMode && machines.some((machine) => machine.access === undefined)) {
            if (!shouldContinue()) return;
            expectedAccountMode = await params.readAccountMode();
        }
    } catch (error) {
        // A retired prepared read says nothing about the current Home's availability.
        if (error instanceof StaleServerGenerationError) return;
        if (shouldContinue()) params.onListUnavailable?.(error);
        if (throwOnError) {
            throw error;
        }
        return;
    }

    if (!shouldContinue()) {
        return;
    }

    let hasOlderRows = false;
    const currentMachineSnapshot = params.getMachineSnapshot?.();
    const rowIsNotOlder = (machine: FetchedMachineRow) => {
        const existing = params.getExistingMachine?.(machine.id) ?? params.getMachineSnapshot?.()[machine.id];
        return !existing || (machine.metadataVersion >= existing.metadataVersion
            && (machine.daemonStateVersion ?? 0) >= existing.daemonStateVersion);
    };
    machines = machines.filter((machine) => {
        const accepted = rowIsNotOlder(machine) && isRequestMachineContextCurrent?.(machine.id) !== false
            && (!requestMachineSnapshot || isMachineReadSnapshotCurrent(currentMachineSnapshot?.[machine.id], requestMachineSnapshot[machine.id]));
        if (!accepted) hasOlderRows = true;
        return accepted;
    });
    machines = machines.map((machine) => {
        if (machine.access === undefined) return machine;
        const access = AccessibleMachineAccessStoredReadV1Schema.safeParse(machine.access);
        return { ...machine, access: access.success ? access.data : undefined,
            isShared: !access.success || access.data.custodian.accountId !== viewerAccountId };
    });
    const accessLockedReason = (machine: FetchedMachineRow): MachineLockedReason | null => {
        if (!machine.isShared && machine.access === undefined) return null;
        const reason = machine.access?.reason;
        if (machine.access?.accessState !== 'ready' && (reason === 'content_unpublished'
            || reason === 'custodian_only' || reason === 'daemon_upgrade_required')) return reason;
        if (machine.access?.accessState === 'key_pending') return 'recipient_key_pending';
        if (machine.access?.accessState === 'refused') return 'recipient_access_refused';
        return machine.access?.accessState === 'ready' ? null : 'encryption_material_unavailable';
    };
    const machineContexts = new Map(machines.map((machine) => [machine.id, encryption?.captureMachineEncryptionContext(
        machine.id, readMachineEncryptionContextInput(machine, viewerAccountId),
    )] as const));
    params.onRowsObserved?.(machines);
    const capturedRows = new Map(machines.map((machine) => [machine.id, machine] as const));
    const incumbentRows = new Map(machines.map((machine) => [machine.id,
        currentMachineSnapshot?.[machine.id] ?? params.getExistingMachine?.(machine.id) ?? null,
    ] as const));
    const readIncumbentRow = (machineId: string) => (params.getMachineSnapshot
        ? params.getMachineSnapshot()[machineId] : params.getExistingMachine?.(machineId)) ?? null;
    let hydratingPublishedRows = false;
    const isMachineCurrent = (machineId: string) => {
        const row = capturedRows.get(machineId);
        return shouldContinue() && machineContexts.get(machineId)?.isCurrent() !== false
            && (!(params.getMachineSnapshot || params.getExistingMachine) || (hydratingPublishedRows
                ? isMachineHydrationSnapshotCurrent(readIncumbentRow(machineId), incumbentRows.get(machineId))
                : isMachineReadSnapshotCurrent(readIncumbentRow(machineId), incumbentRows.get(machineId))))
            && Boolean(row && (hydratingPublishedRows || rowIsNotOlder(row)));
    };
    const applyCurrentMachines = (incoming: Machine[], replace: boolean) => {
        const current = incoming.filter((machine) => isMachineCurrent(machine.id)).map((machine) => {
            const presence = readIncumbentRow(machine.id);
            const captured = requestMachineSnapshot ? requestMachineSnapshot[machine.id] : incumbentRows.get(machine.id);
            if (!presence || presence === machine) return machine;
            const activity = readMachineActivity(presence);
            const activeAt = activity.activeAt ?? presence.activeAt;
            const readBasis = machine.keyBasis;
            const currentBasis = presence.keyBasis;
            // Preserve newer same-key hints before warm publication as well as
            // hydration. An older HTTP row may open useful metadata, but cannot
            // erase a socket's pending-content requirement and admit execution.
            const keyBasis = readBasis && currentBasis
                && readBasis.dataEncryptionKey === currentBasis.dataEncryptionKey
                && (currentBasis.metadataVersion > readBasis.metadataVersion
                    || currentBasis.daemonStateVersion > readBasis.daemonStateVersion)
                ? { ...readBasis, metadataVersion: Math.max(readBasis.metadataVersion, currentBasis.metadataVersion),
                    daemonStateVersion: Math.max(readBasis.daemonStateVersion, currentBasis.daemonStateVersion) }
                : readBasis;
            const merged = {
                ...machine,
                ...(hydratingPublishedRows ? {
                    updatedAt: Math.max(machine.updatedAt, presence.updatedAt),
                    ...(presence.metadataVersion > machine.metadataVersion
                        ? { metadata: presence.metadata, metadataVersion: presence.metadataVersion } : {}),
                    ...(presence.daemonStateVersion > machine.daemonStateVersion
                        && (presence.daemonState != null || presence.availability?.kind === 'available')
                        ? { daemonState: presence.daemonState, daemonStateVersion: presence.daemonStateVersion } : {}),
                    ...(presence.keyBasis ? { keyBasis: presence.keyBasis } : {}),
                } : {}),
                ...(keyBasis ? { keyBasis } : {}),
                ...((activity.active !== captured?.active || activeAt !== captured?.activeAt)
                    // A held read cannot erase newer local liveness, nor can a
                    // pre-request activity fact overwrite a newer HTTP fact.
                    && activeAt >= machine.activeAt
                    ? { active: activity.active, activeAt } : {}),
            };
            // A newer hint cannot withdraw already admitted same-key content.
            // Unopened rows still wait for current content, and fresh execution
            // is independently qualified by the inventory's current-content read.
            const qualified = hydratingPublishedRows && merged.metadata && merged.availability?.kind === 'available'
                && !hasCurrentMachineContent(merged) && !canRetainOpenedMachineContent(merged, presence)
                ? { ...merged, availability: undefined } : merged;
            return qualified;
        });
        applyMachines(current, replace && current.length === incoming.length && isCensusMembershipCurrent(),
            current.flatMap(machine => {
                const row = capturedRows.get(machine.id);
                return row ? [row] : [];
            }));
        observePresence(current.map(machine => machine.id));
        // Warm publication is this read's own synchronous write. Carry its exact
        // resulting row forward so later hydration does not reject itself, but do
        // not adopt a reentrant access/context change made by another producer.
        for (const machine of current) {
            const installed = readIncumbentRow(machine.id);
            if (installed && areStoredMachineSemanticsEqual(installed, machine)) {
                incumbentRows.set(machine.id, installed);
            }
        }
    };

    const unavailableMachineIds = new Set<string>();
    const plainMachineIds = new Set<string>();
    const freshKeyByMachineId = new Map<string, Uint8Array | null>();
    const initializedMachineIds = new Set<string>();
    let machineEncryptionReady = encryption !== null;
    type MachineKeyKind = 'plain' | 'legacy' | 'encrypted' | 'encrypted_unavailable';
    const classifyMachineKey = (machine: FetchedMachineRow): Readonly<{ kind: MachineKeyKind; envelope: string | null }> => {
        if (accessLockedReason(machine)) return { kind: 'encrypted_unavailable', envelope: null };
        if (machine.access?.resourceMode === 'plain') return { kind: 'plain', envelope: null };
        if (machine.isShared && !machine.dataEncryptionKey) return { kind: 'encrypted_unavailable', envelope: null };
        if (isPlainMachineDataKeyMarker(machine.dataEncryptionKey)) return { kind: 'plain', envelope: null };
        if (machine.dataEncryptionKey === null || machine.dataEncryptionKey === undefined) return { kind: 'legacy', envelope: null };
        if (!encryption) return { kind: 'encrypted_unavailable', envelope: null };
        return { kind: 'encrypted', envelope: machine.dataEncryptionKey };
    };
    const initializeMachineKeys = async (selectedMachines: readonly FetchedMachineRow[]) => {
        selectedMachines = selectedMachines.filter(machine => !initializedMachineIds.has(machine.id));
        if (selectedMachines.length === 0) return;
        for (const machine of selectedMachines) initializedMachineIds.add(machine.id);
        const machineKeysMap = new Map<string, Uint8Array | null>();
        const reusedKeyByMachineId = new Map<string, Uint8Array>();
        const pendingMachineIds: string[] = [];
        const pendingEnvelopes: string[] = [];
        const machineKeyKinds = selectedMachines.map((machine) => {
            const classified = classifyMachineKey(machine);
            if (classified.kind === 'encrypted' && classified.envelope) {
                const cached = machineDataKeys.get(machine.id);
                if (cached && cached.envelope === classified.envelope) {
                    reusedKeyByMachineId.set(machine.id, cached.dataKey);
                } else {
                    pendingMachineIds.push(machine.id);
                    pendingEnvelopes.push(classified.envelope);
                }
            }
            return { machineId: machine.id, ...classified };
        });
        let pendingDecryptedKeys: Array<Uint8Array | null> = [];
        if (encryption && pendingEnvelopes.length > 0) {
            try {
                pendingDecryptedKeys = await encryption.decryptEncryptionKeys(pendingEnvelopes);
            } catch (error) {
                // A cancelled opening is not a refusal: this read publishes no locked rows.
                if (isDataKeyOpeningCancelled(error)) throw error;
                pendingDecryptedKeys = pendingEnvelopes.map(() => null);
            }
        }
        for (let index = 0; index < pendingMachineIds.length; index += 1) {
            freshKeyByMachineId.set(pendingMachineIds[index]!, pendingDecryptedKeys[index] ?? null);
        }
        const machineById = new Map(selectedMachines.map((machine) => [machine.id, machine] as const));
        // Every admitted row resolves creator custody, including rows relabelled
        // by the Home. Concurrent reads share cold work at the custody owner.
        const runnerTrustByMachineId = new Map(await Promise.all(selectedMachines.map(async (machine) => [
            machine.id,
            await resolveRunnerMachineContentKeyTrustV1({
                credentials,
                homeServerIdentityId: params.sourceServerId,
                machineId: machine.id,
            }),
        ] as const)));
        if (!shouldContinue()) return;
        const custody = readAccountE2eeCustody(credentials);
        const admitsPlainMachineRow = (machine: FetchedMachineRow) => {
            try {
                admitMachineRowPlainMode({ access: machine.access, viewerAccountId: viewerAccountId ?? undefined, custody });
                return true;
            } catch {
                return false;
            }
        };
        for (const result of machineKeyKinds) {
            if (!isMachineCurrent(result.machineId)) continue;
            const reusedKey = reusedKeyByMachineId.get(result.machineId);
            const decryptedKey = reusedKey ?? freshKeyByMachineId.get(result.machineId) ?? null;
            const machine = machineById.get(result.machineId)!;
            // Resolved for every Machine: the trusted classification must not be
            // suppressed by the very field a hostile Home would rewrite.
            const runnerTrust = runnerTrustByMachineId.get(machine.id);
            const resolved = accessLockedReason(machine) || (machine.isShared && result.kind === 'encrypted_unavailable')
                ? { status: 'unavailable' as const }
                : !runnerTrust && encryption && result.kind !== 'plain'
                ? { status: 'unavailable' as const }
                : resolvePublishedMachineDataEncryptionKeyV1({
                machine,
                openedDataEncryptionKey: decryptedKey,
                viewerAccountId: viewerAccountId ?? undefined,
                expectedAccountMode: machine.access?.resourceMode ?? machine.storageMode ?? expectedAccountMode,
                ...(runnerTrust ? { expectedRunnerBinding: runnerTrust.expectedRunnerBinding } : {}),
                ...(runnerTrust?.trustedMachineKind ? { trustedMachineKind: runnerTrust.trustedMachineKind } : {}),
            });
            const resolution = resolved.status === 'plain' && !admitsPlainMachineRow(machine) ? { status: 'unavailable' as const } : resolved;
            if (resolution.status !== 'e2ee') {
                // A rotated envelope that fails to open — or a machine that moved to plain or
                // legacy storage — must not leave the previous key cached: the next refresh
                // would reuse a key this machine no longer uses.
                machineDataKeys.delete(result.machineId);
            }
            if (resolution.status === 'unavailable') {
                if (encryption) {
                    warnMachineDataEncryptionKeyDecryptFailureOnce(encryption, result.machineId);
                } else {
                    console.warn(`Account encryption material is unavailable for machine ${result.machineId}.`);
                }
                unavailableMachineIds.add(result.machineId);
                continue;
            }
            if (resolution.status === 'plain') {
                plainMachineIds.add(result.machineId);
                continue;
            }
            const acceptedKey = resolution.status === 'e2ee' ? resolution.dataKey : null;
            machineKeysMap.set(result.machineId, acceptedKey);
            if (acceptedKey && result.envelope) {
                machineDataKeys.set(result.machineId, { envelope: result.envelope, dataKey: acceptedKey });
            }
        }

        // Initialize machine encryptions
        if (encryption) {
            try {
                const retiredMachineIds = new Set(selectedMachines.filter(machine =>
                    unavailableMachineIds.has(machine.id) || plainMachineIds.has(machine.id)).map(machine => machine.id));
                await encryption.initializeMachines(machineKeysMap, retiredMachineIds, { isMachineCurrent });
            } catch (error) {
                machineEncryptionReady = false;
                console.error('[machinesSnapshot] Failed to initialize machine encryption; continuing with cached/unencrypted machine rows', error);
            }
        }

    };

    // Re-admit retained opened content before publishing it. Unopened rows need
    // only a display shell; their fresh keys belong to the existing selective
    // hydration jobs. Exact/non-display readers await complete crypto admission.
    const shouldApplyMachineDisplays = typeof params.applyMachineDisplayEntries === 'function';
    await initializeMachineKeys(shouldApplyMachineDisplays ? machines.filter(machine => {
        const classified = classifyMachineKey(machine);
        const retained = incumbentRows.get(machine.id);
        return classified.kind !== 'encrypted' || machineDataKeys.get(machine.id)?.envelope === classified.envelope
            || Boolean(retained?.metadata || retained?.daemonState);
    }) : machines);

    if (!shouldContinue()) {
        return;
    }

    const needsMachineWarmHydration = (machine: typeof machines[number]): boolean => {
        if (plainMachineIds.has(machine.id) || unavailableMachineIds.has(machine.id)) {
            return false;
        }
        if (!initializedMachineIds.has(machine.id)) return true;
        if (freshKeyByMachineId.has(machine.id)) return true;
        const existingMachine = readIncumbentRow(machine.id);
        if (!existingMachine?.metadata || existingMachine.metadataVersion !== machine.metadataVersion) {
            return true;
        }
        if (existingMachine.storageMode !== 'e2ee' || !canRetainOpenedMachineContent(machine, existingMachine)) {
            return true;
        }
        return typeof machine.daemonState === 'string' && machine.daemonState.length > 0
            && existingMachine.daemonStateVersion !== (machine.daemonStateVersion || 0);
    };

    const buildMachineFromRowAndExisting = (
        machine: FetchedMachineRow,
        existingMachine: Machine | null | undefined,
    ): Machine => {
        if (unavailableMachineIds.has(machine.id)) {
            return createLockedMachineView(
                machine,
                accessLockedReason(machine) ?? (encryption ? 'decryption_failed' : 'encryption_material_unavailable'),
                machine.access?.resourceMode,
                existingMachine,
            );
        }
        if (plainMachineIds.has(machine.id)) {
            try {
                return createReadablePlainMachineView(machine, existingMachine);
            } catch (error) {
                console.error(`Failed to read plaintext machine ${machine.id}:`, error);
                return createLockedMachineView(machine, 'content_unreadable', 'plain', existingMachine);
            }
        }
        if (!encryption) {
            return createLockedMachineView(machine, 'encryption_material_unavailable', 'e2ee', existingMachine);
        }
        if (!machineEncryptionReady || (initializedMachineIds.has(machine.id) && !encryption.getMachineEncryption(machine.id))) {
            return createLockedMachineView(machine, 'decryption_failed', 'e2ee', existingMachine);
        }
        const hasEncryptedDaemonState = typeof machine.daemonState === 'string' && machine.daemonState.length > 0;
        // Keep decrypted capabilities and their version while a fresh envelope is pending.
        // The availability checks above still fail closed when encryption or trust is unavailable.
        const canReuseContent = initializedMachineIds.has(machine.id) && canRetainOpenedMachineContent(machine, existingMachine);
        // Encryption's ingress already admits these fields through their stored
        // schemas. Re-parsing typed incumbents discards their retained identity.
        const metadata = projectMachinePublishedMetadataFromRowV1(machine.metadata && canReuseContent ? existingMachine?.metadata ?? null : null, machine.devcontainerChild);
        return {
            id: machine.id,
            seq: machine.seq,
            createdAt: machine.createdAt,
            updatedAt: machine.updatedAt,
            active: machine.active,
            activeAt: machine.activeAt,
            revokedAt: machine.revokedAt ?? null,
            metadataVersion: metadata && existingMachine ? existingMachine.metadataVersion : machine.metadataVersion,
            metadata,
            daemonState: hasEncryptedDaemonState && canReuseContent ? existingMachine?.daemonState ?? null : null,
            daemonStateVersion: hasEncryptedDaemonState && canReuseContent
                ? existingMachine?.daemonStateVersion ?? 0
                : readUnopenedDaemonStateVersion(machine),
            ...readMachineIdentityFields(machine),
            ...readMachinePublishedContext(machine),
            storageMode: 'e2ee',
            // Warming newer content must not withdraw the opened same-key
            // presentation; fresh execution still requires current versions.
            ...(canReuseContent && existingMachine?.storageMode === 'e2ee'
                && canRetainOpenedMachineContent(machine, existingMachine)
                // Without published version hints, retained old versions look
                // current to fresh readers. Preserve legacy hydration admission.
                && (machine.keyBasis != null || !needsMachineWarmHydration(machine))
                ? { availability: existingMachine.availability } : {}),
        };
    };

    // Metadata and daemon opens share the existing finite crypto budget.
    // A held daemon open cannot occupy a metadata hydration slot.
    const hydrateContent = createTaskLimiter(concurrencyLimit);
    let hydrationYield: Promise<void> | null = null;
    const hydrationPublication = createHydrationPublication({
        readCurrentMachine: readIncumbentRow,
        isCohortReleased: () => hydrationYield === null,
        cohortSize: concurrencyLimit,
        hasWaitingTasks: hydrateContent.hasWaitingTasks,
        publish: batch => {
            if (!shouldContinue()) return;
            applyCurrentMachines(batch, false);
            hydratingPublishedRows = true;
        },
    });
    const yieldHydrationCohort = () => {
        if (!hydrationYield) hydrationYield = yieldToEventLoop().then(() => {
            // Gather the previous cohort's asynchronous completions before
            // releasing the next one through the existing crypto yield.
            hydrationPublication.flush();
            hydrationYield = null;
        });
        return hydrationYield;
    };

    let initializeHydrationKey = async (machine: FetchedMachineRow) => {
        if (isMachineCurrent(machine.id)) await initializeMachineKeys([machine]);
    };

    const openMachineMetadata = async (machine: FetchedMachineRow): Promise<{
        machine: Machine;
        encryption: MachineEncryption | null;
    } | null> => {
        if (shouldApplyMachineDisplays) await yieldHydrationCohort();
        await initializeHydrationKey(machine);
        if (!isMachineCurrent(machine.id)) return null;
        const existingMachine = readIncumbentRow(machine.id);
        if (unavailableMachineIds.has(machine.id) || plainMachineIds.has(machine.id)
            || !needsMachineWarmHydration(machine)) {
            return { machine: buildMachineFromRowAndExisting(machine, existingMachine), encryption: null };
        }
        const machineEncryption = encryption?.getMachineEncryption(machine.id);
        if (!machineEncryption) {
            return { machine: createLockedMachineView(machine,
                encryption ? 'decryption_failed' : 'encryption_material_unavailable', 'e2ee', existingMachine), encryption: null };
        }
        try {
            const metadata = machine.metadata
                ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata) : null;
            if (!isMachineCurrent(machine.id) || encryption?.getMachineEncryption(machine.id) !== machineEncryption) return null;
            if (machine.isShared && !metadata) {
                return { machine: createLockedMachineView(machine, 'content_unreadable', 'e2ee', existingMachine), encryption: null };
            }
            const retained = buildMachineFromRowAndExisting(machine, existingMachine);
            const openedDaemon = existingMachine && haveSameMachineContentAuthority(existingMachine, machine)
                ? existingMachine : retained;
            return { encryption: machineEncryption, machine: {
                ...retained,
                metadata: projectMachinePublishedMetadataFromRowV1(metadata, machine.devcontainerChild),
                metadataVersion: machine.metadataVersion,
                // An unopened daemon revision is only a hint. Keep actual
                // same-key opened capabilities while the new revision opens.
                daemonState: openedDaemon.daemonState,
                daemonStateVersion: openedDaemon.daemonState != null || openedDaemon.availability?.kind === 'available'
                    ? openedDaemon.daemonStateVersion : 0,
            } };
        } catch (error) {
            if (!isMachineCurrent(machine.id) || encryption?.getMachineEncryption(machine.id) !== machineEncryption) return null;
            console.error(`Failed to decrypt machine ${machine.id}:`, error);
            return { machine: createLockedMachineView(machine, 'decryption_failed', 'e2ee', existingMachine), encryption: null };
        }
    };

    const decryptMachine = async (machine: FetchedMachineRow): Promise<Machine | null> => {
        // Queue every Machine's key/metadata phase before daemon phases. A
        // pending daemon cannot hold an offline peer's display metadata slot.
        const opened = await hydrateContent(() => openMachineMetadata(machine));
        if (!opened || !opened.encryption) return opened?.machine ?? null;
        const machineEncryption = opened.encryption;
        if (machine.daemonState) hydrationPublication.enqueue(opened.machine, true);
        try {
            const daemonStateCipher = machine.daemonState;
            const daemonState = daemonStateCipher ? await hydrateContent(async () => {
                // Already-opened names never wait for a held daemon read.
                hydrationPublication.flushMetadata();
                if (!isMachineCurrent(machine.id) || encryption?.getMachineEncryption(machine.id) !== machineEncryption) return null;
                return machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, daemonStateCipher);
            }) : null;
            if (!isMachineCurrent(machine.id) || encryption?.getMachineEncryption(machine.id) !== machineEncryption) return null;
            return { ...opened.machine, daemonState, daemonStateVersion: machine.daemonStateVersion || 0,
                availability: { kind: 'available' } };
        } catch (error) {
            if (!isMachineCurrent(machine.id) || encryption?.getMachineEncryption(machine.id) !== machineEncryption) return null;
            console.error(`Failed to decrypt machine ${machine.id}:`, error);
            return createLockedMachineView(machine, 'decryption_failed', 'e2ee', readIncumbentRow(machine.id));
        }
    };

    if (shouldApplyMachineDisplays) {
        const warmMachines = machines.filter((machine) => isMachineCurrent(machine.id)).map((machine) => buildMachineFromRowAndExisting(
            machine,
            readIncumbentRow(machine.id),
        ));
        const displayEntries = warmMachines.map((machine) => {
            const display = buildMachineDisplayRenderableFromMachine(machine);
            if (display.metadata || machine.availability?.kind === 'locked') return display;
            const cachedEntry = params.getCachedMachineDisplayEntry?.(machine.id);
            if (!cachedEntry || cachedEntry.metadataVersion !== machine.metadataVersion) return display;
            return {
                ...display,
                metadata: {
                    displayName: cachedEntry.displayName ?? null,
                    host: cachedEntry.host ?? null,
                    homeDir: cachedEntry.homeDir ?? null,
                },
            };
        });
        const replace = completeCensus && (params.replace ?? false) && !hasOlderRows
            && isCensusMembershipCurrent() && machines.every((machine) => isMachineCurrent(machine.id));
        params.applyMachineDisplayEntries!(displayEntries, { replace });
        applyCurrentMachines(warmMachines, replace);
        hydratingPublishedRows = true;

        const machinesNeedingHydration = machines
            .filter((machine) =>
                plainMachineIds.has(machine.id) || machineEncryptionReady)
            .filter((machine) => needsMachineWarmHydration(machine))
            .sort((left, right) => {
                const leftOnline = isMachineOnline(readIncumbentRow(left.id) ?? left);
                const rightOnline = isMachineOnline(readIncumbentRow(right.id) ?? right);
                if (leftOnline !== rightOnline) return leftOnline ? -1 : 1;
                const leftActivity = Math.max(left.activeAt ?? 0, left.updatedAt ?? 0);
                const rightActivity = Math.max(right.activeAt ?? 0, right.updatedAt ?? 0);
                return rightActivity - leftActivity;
            });
        if (machinesNeedingHydration.length > 0) {
            const onlineKeys = new Set(machinesNeedingHydration.filter(machine =>
                isMachineOnline(readIncumbentRow(machine.id) ?? machine)).map(machine => machine.id));
            let releaseOnlineKeys!: () => void;
            const onlineKeysOpened = new Promise<void>(resolve => { releaseOnlineKeys = resolve; });
            if (onlineKeys.size === 0) releaseOnlineKeys();
            initializeHydrationKey = async machine => {
                const online = onlineKeys.has(machine.id);
                try {
                    // The crypto owner coalesces same-turn envelopes. Preserve
                    // separate online/offline native key batches, without waiting
                    // for online metadata or daemon-state decryption.
                    if (!online && !initializedMachineIds.has(machine.id)) await onlineKeysOpened;
                    if (isMachineCurrent(machine.id)) await initializeMachineKeys([machine]);
                } finally {
                    if (online && onlineKeys.delete(machine.id) && onlineKeys.size === 0) releaseOnlineKeys();
                }
            };
            // Keep this read joined to its InvalidateSync attempt. Display rows
            // are already published; otherwise this older completion could
            // overwrite the outcome of a newer list read.
            await Promise.all(machinesNeedingHydration.map(async (machine) => {
                const decryptedMachine = await decryptMachine(machine);
                if (decryptedMachine && isMachineCurrent(machine.id)) hydrationPublication.enqueue(decryptedMachine);
            })).then(() => {
                hydrationPublication.flush();
                if (shouldContinue()) params.onListComplete?.();
            }).catch((error) => {
                console.error('[machinesSnapshot] Background hydration failed', error);
                if (shouldContinue()) params.onListUnavailable?.(error);
            });
        } else if (shouldContinue()) {
            params.onListComplete?.();
        }

        log.log(`🖥️ fetchMachines completed - rendered ${displayEntries.length} machine display rows and completed selective hydration`);
        return;
    }

    // Complete full content before the final authoritative census replacement.
    const decryptedResults = await Promise.all(machines.map(decryptMachine));
    const decryptedMachines = decryptedResults.filter((machine): machine is Machine => Boolean(machine));

    // Prefer incremental publication by default. Complete replacement also
    // rechecks omitted rows against the pre-request membership/sequence basis.
    if (!shouldContinue()) return;
    applyCurrentMachines(decryptedMachines, completeCensus && (params.replace ?? false) && !hasOlderRows && machines.every((machine) => isMachineCurrent(machine.id)));
    if (shouldContinue()) params.onListComplete?.();
    log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
}
