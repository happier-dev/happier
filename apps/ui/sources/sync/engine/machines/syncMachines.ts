import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { log } from '@/log';
import type { Machine, MachineLockedReason } from '@/sync/domains/state/storageTypes';
import { serverFetch } from '@/sync/http/client';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { buildMachineDisplayRenderableFromMachine, type MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { MachineKindFromLegacyProjectionSchema } from '@happier-dev/protocol/machines/machineKind';
import { MachineOperationProtocolCapabilitiesV1StoredReadSchema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { decodePlainMachineStoredContent, isPlainMachineDataKeyMarker, resolvePublishedMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { resolveRunnerMachineContentKeyTrustV1 } from '@/sync/domains/machines/runnerMachineContentKeyTrust';
import type { MachineEncryptionContext, MachineEncryptionContextInput } from '@/sync/encryption/encryption';
import { readMachineEncryptionContextInput } from '@/sync/encryption/machineEncryption';
import { parseToken } from '@/utils/auth/parseToken';
import { AccessibleMachineAccessStoredReadV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { StoredMachinePublishedMetadataV1Schema, StoredMachinePublishedDaemonStateV1Schema, projectMachinePublishedMetadataFromRowV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { DevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { encodeBase64 } from '@/encryption/base64';
import { yieldToEventLoop } from '@/sync/encryption/cryptoBatchYield';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { hasCurrentMachineContent } from '@/sync/domains/machines/resolveServerScopedMachines';
import { readMachineCensus } from '@/sync/api/machines/machineRowsApi';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

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
        dataEncryptionKey: machine.dataEncryptionKey ?? null,
        ...(machine.keyBasis !== undefined ? { keyBasis: machine.keyBasis } : {}),
        ...(machine.access !== undefined ? { access: machine.access } : {}),
        ...(machine.isShared !== undefined ? { isShared: machine.isShared } : {}),
    };
}

function createLockedMachineView(
    machine: FetchedMachineRow,
    reason: MachineLockedReason,
    storageMode: 'plain' | 'e2ee' = 'e2ee',
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

function createReadablePlainMachineView(machine: FetchedMachineRow): Machine {
    const metadata = machine.metadata
        ? StoredMachinePublishedMetadataV1Schema.safeParse(decodePlainMachineStoredContent(machine.metadata))
        : null;
    if (!metadata?.success) return createLockedMachineView(machine, 'content_unreadable', 'plain');
    const daemonState = machine.daemonState
        ? StoredMachinePublishedDaemonStateV1Schema.safeParse(decodePlainMachineStoredContent(machine.daemonState))
        : null;
    return {
        id: machine.id,
        seq: machine.seq,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        metadata: projectMachinePublishedMetadataFromRowV1(metadata.data, machine.devcontainerChild),
        metadataVersion: machine.metadataVersion,
        daemonState: daemonState?.success ? daemonState.data : null,
        daemonStateVersion: machine.daemonStateVersion ?? 0,
        storageMode: 'plain',
        availability: { kind: 'available' },
        ...readMachineIdentityFields(machine),
        ...readMachinePublishedContext(machine),
    };
}

/** Same-key pending content retains presentation, never fresh execution authority. */
function canRetainOpenedMachineContent(machine: Pick<Machine, 'keyBasis' | 'dataEncryptionKey'>, incumbent: Machine | null | undefined): boolean {
    const key = machine.keyBasis ? machine.keyBasis.dataEncryptionKey : machine.dataEncryptionKey ?? null;
    const incumbentKey = incumbent?.keyBasis ? incumbent.keyBasis.dataEncryptionKey : incumbent?.dataEncryptionKey ?? null;
    return incumbent?.availability?.kind === 'available'
        && incumbentKey === key
        && (incumbent.dataEncryptionKey ?? null) === (machine.dataEncryptionKey ?? null);
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
        // IMPORTANT: socket UpdateContainer.seq is an account cursor, not the machine entity seq.
        seq: existingMachine?.seq ?? 0,
        createdAt: existingMachine?.createdAt ?? updateCreatedAt,
        updatedAt: updateCreatedAt,
        active: nextRevokedAt ? false : (machineUpdate.active ?? existingMachine?.active ?? false),
        activeAt: machineUpdate.activeAt ?? existingMachine?.activeAt ?? updateCreatedAt,
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
            && daemonStateUpdate.version > (existingMachine.daemonStateVersion ?? 0)
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

const machineActivityPlaceholderContent = {
    seq: 0,
    revokedAt: null,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
} as const;

/** The first socket heartbeat carries presence, not a content/access context. */
export function buildMachineActivityPlaceholder(update: { id: string; active: boolean; activeAt: number }): Machine {
    return {
        ...machineActivityPlaceholderContent,
        id: update.id,
        createdAt: update.activeAt,
        updatedAt: update.activeAt,
        active: update.active,
        activeAt: update.activeAt,
    };
}

export function isMachineActivityPlaceholder(machine: Machine): boolean {
    const placeholder = buildMachineActivityPlaceholder(machine);
    return Object.keys(machine).every((key) => Object.prototype.hasOwnProperty.call(placeholder, key))
        && Object.entries(machineActivityPlaceholderContent).every(([key, value]) => machine[key as keyof Machine] === value);
}

export function buildMachineFromMachineActivityEphemeralUpdate(params: {
    machine: Machine;
    updateData: { active: boolean; activeAt: number };
}): Machine {
    const { machine, updateData } = params;
    return {
        ...machine,
        active: updateData.active,
        activeAt: updateData.activeAt,
    };
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
    cachedMachineDisplayEntries?: Record<string, MachineDisplayCacheEntryV1>;
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
     * When true, drop any locally-cached machines that are missing from the
     * latest fetch response.
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
    const { credentials, encryption, machineDataKeys, applyMachines } = params;
    let viewerAccountId: string | null = null;
    try { viewerAccountId = parseToken(credentials.token); } catch { /* Historical token-only Plain reads need no content key. */ }
    const observePresence = captureMachinePresenceObservation(createServerAccountScope(params.sourceServerId, viewerAccountId));
    const concurrencyLimit = Math.max(1, Math.trunc(params.machineDisplayHydrationConcurrencyLimit ?? 4));
    const shouldContinue = params.shouldContinue ?? (() => true);
    const throwOnError = params.throwOnError === true;
    const isRequestMachineContextCurrent = encryption?.captureMachineEncryptionContextRead();
    const requestMachineSnapshot = params.getMachineSnapshot?.();

    let machines: readonly FetchedMachineRow[];
    try {
        machines = await fetchMachineRows({
            credentials,
            ...(params.request ? { request: params.request } : {}),
            readTransport: params.readTransport,
            signal: params.signal,
        });
    } catch (error) {
        if (shouldContinue()) params.onListUnavailable?.(error);
        if (throwOnError) {
            throw error;
        }
        return;
    }

    if (!shouldContinue()) {
        return;
    }

    let expectedAccountMode = params.expectedAccountMode;
    if (expectedAccountMode === undefined && params.readAccountMode && machines.some((machine) => machine.access === undefined)) {
        try { expectedAccountMode = await params.readAccountMode(); }
        catch (error) {
            if (shouldContinue()) params.onListUnavailable?.(error);
            if (throwOnError) throw error;
            return;
        }
        if (!shouldContinue()) return;
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
            if (!presence) return machine;
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
                        ? { daemonState: presence.daemonState, daemonStateVersion: presence.daemonStateVersion } : {}),
                    ...(presence.keyBasis ? { keyBasis: presence.keyBasis } : {}),
                } : {}),
                ...(keyBasis ? { keyBasis } : {}),
                ...(presence.active !== captured?.active || presence.activeAt !== captured?.activeAt
                    ? { active: presence.active, activeAt: presence.activeAt } : {}),
            };
            // A newer hint cannot withdraw already admitted same-key content.
            // Unopened rows still wait for current content, and fresh execution
            // is independently qualified by the inventory's current-content read.
            return hydratingPublishedRows && merged.metadata && merged.availability?.kind === 'available'
                && !hasCurrentMachineContent(merged) && !canRetainOpenedMachineContent(merged, presence)
                ? { ...merged, availability: undefined } : merged;
        });
        applyMachines(current, replace && current.length === incoming.length,
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
            if (installed && installed.dataEncryptionKey === machine.dataEncryptionKey
                && installed.keyBasis === machine.keyBasis && installed.access === machine.access
                && installed.storageMode === machine.storageMode
                && installed.metadataVersion === machine.metadataVersion && installed.metadata === machine.metadata
                && installed.daemonStateVersion === machine.daemonStateVersion && installed.daemonState === machine.daemonState) {
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
            } catch {
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
        for (const result of machineKeyKinds) {
            if (!isMachineCurrent(result.machineId)) continue;
            const reusedKey = reusedKeyByMachineId.get(result.machineId);
            const decryptedKey = reusedKey ?? freshKeyByMachineId.get(result.machineId) ?? null;
            const machine = machineById.get(result.machineId)!;
            // Resolved for every Machine: the trusted classification must not be
            // suppressed by the very field a hostile Home would rewrite.
            const runnerTrust = runnerTrustByMachineId.get(machine.id);
            const resolution = accessLockedReason(machine) || (machine.isShared && result.kind === 'encrypted_unavailable')
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

    const cachedMachineDisplayEntries = params.cachedMachineDisplayEntries ?? {};
    const needsMachineWarmHydration = (machine: typeof machines[number]): boolean => {
        if (plainMachineIds.has(machine.id) || unavailableMachineIds.has(machine.id)) {
            return false;
        }
        if (!initializedMachineIds.has(machine.id)) return true;
        if (freshKeyByMachineId.has(machine.id)) return true;
        const existingMachine = params.getExistingMachine?.(machine.id);
        if (!existingMachine?.metadata || existingMachine.metadataVersion !== machine.metadataVersion) {
            return true;
        }
        if (existingMachine.storageMode !== 'e2ee' || existingMachine.availability?.kind !== 'available') {
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
            );
        }
        if (plainMachineIds.has(machine.id)) {
            try {
                return createReadablePlainMachineView(machine);
            } catch (error) {
                console.error(`Failed to read plaintext machine ${machine.id}:`, error);
                return createLockedMachineView(machine, 'content_unreadable', 'plain');
            }
        }
        if (!encryption) {
            return createLockedMachineView(machine, 'encryption_material_unavailable');
        }
        if (!machineEncryptionReady || (initializedMachineIds.has(machine.id) && !encryption.getMachineEncryption(machine.id))) {
            return createLockedMachineView(machine, 'decryption_failed');
        }
        const hasEncryptedDaemonState = typeof machine.daemonState === 'string' && machine.daemonState.length > 0;
        // Keep decrypted capabilities and their version while a fresh envelope is pending.
        // The availability checks above still fail closed when encryption or trust is unavailable.
        const canReuseContent = initializedMachineIds.has(machine.id) && (!machine.isShared || (existingMachine?.access?.accessState === 'ready'
            && existingMachine.dataEncryptionKey === machine.dataEncryptionKey));
        const retainedMetadata = StoredMachinePublishedMetadataV1Schema.safeParse(existingMachine?.metadata);
        const retainedDaemonState = StoredMachinePublishedDaemonStateV1Schema.safeParse(existingMachine?.daemonState);
        const metadata = projectMachinePublishedMetadataFromRowV1(machine.metadata && canReuseContent && retainedMetadata.success ? retainedMetadata.data : null, machine.devcontainerChild);
        return ({
            id: machine.id,
            seq: machine.seq,
            createdAt: machine.createdAt,
            updatedAt: machine.updatedAt,
            active: machine.active,
            activeAt: machine.activeAt,
            revokedAt: machine.revokedAt ?? null,
            metadataVersion: metadata && existingMachine ? existingMachine.metadataVersion : machine.metadataVersion,
            metadata,
            daemonState: hasEncryptedDaemonState && canReuseContent && retainedDaemonState.success ? retainedDaemonState.data : null,
            daemonStateVersion: hasEncryptedDaemonState && canReuseContent
                ? existingMachine?.daemonStateVersion ?? (machine.daemonStateVersion || 0)
                : (machine.daemonStateVersion || 0),
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
        });
    };

    const decryptMachine = async (machine: typeof machines[number]): Promise<Machine | null> => {
        if (!isMachineCurrent(machine.id)) return null;
        await initializeMachineKeys([machine]);
        if (!isMachineCurrent(machine.id)) return null;
        if (unavailableMachineIds.has(machine.id)) {
            return createLockedMachineView(
                machine,
                accessLockedReason(machine) ?? (encryption ? 'decryption_failed' : 'encryption_material_unavailable'),
                machine.access?.resourceMode,
            );
        }
        if (plainMachineIds.has(machine.id)) {
            try {
                return createReadablePlainMachineView(machine);
            } catch (error) {
                console.error(`Failed to read plaintext machine ${machine.id}:`, error);
                return createLockedMachineView(machine, 'content_unreadable', 'plain');
            }
        }

        const machineEncryption = encryption?.getMachineEncryption(machine.id);
        if (!machineEncryption) {
            console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
            return createLockedMachineView(
                machine,
                encryption ? 'decryption_failed' : 'encryption_material_unavailable',
            );
        }

        try {
            const metadata = machine.metadata
                ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                : null;
            const daemonState = machine.daemonState
                ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                : null;
            if (!isMachineCurrent(machine.id) || encryption?.getMachineEncryption(machine.id) !== machineEncryption) return null;
            if (machine.isShared && !metadata) return createLockedMachineView(machine, 'content_unreadable');

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
                daemonStateVersion: machine.daemonStateVersion || 0,
                ...readMachineIdentityFields(machine),
                ...readMachinePublishedContext(machine),
                storageMode: 'e2ee',
                availability: { kind: 'available' },
            };
        } catch (error) {
            if (!isMachineCurrent(machine.id)) return null;
            console.error(`Failed to decrypt machine ${machine.id}:`, error);
            return createLockedMachineView(machine, 'decryption_failed');
        }
    };

    if (shouldApplyMachineDisplays) {
        const warmMachines = machines.filter((machine) => isMachineCurrent(machine.id)).map((machine) => buildMachineFromRowAndExisting(
            machine,
            params.getExistingMachine?.(machine.id),
        ));
        const displayEntries = warmMachines.map((machine) => {
            const display = buildMachineDisplayRenderableFromMachine(machine);
            const cachedEntry = cachedMachineDisplayEntries[machine.id];
            if (display.metadata || machine.availability?.kind === 'locked'
                || cachedEntry?.metadataVersion !== machine.metadataVersion) return display;
            return {
                ...display,
                metadata: {
                    displayName: cachedEntry.displayName ?? null,
                    host: cachedEntry.host ?? null,
                    homeDir: cachedEntry.homeDir ?? null,
                },
            };
        });
        const replace = (params.replace ?? false) && !hasOlderRows && machines.every((machine) => isMachineCurrent(machine.id));
        params.applyMachineDisplayEntries!(displayEntries, { replace });
        applyCurrentMachines(warmMachines, replace);
        hydratingPublishedRows = true;

        const machinesNeedingHydration = machines
            .filter((machine) =>
                plainMachineIds.has(machine.id) || machineEncryptionReady)
            .filter((machine) => needsMachineWarmHydration(machine))
            .sort((left, right) => {
                if (left.active !== right.active) return left.active ? -1 : 1;
                const leftActivity = Math.max(left.activeAt ?? 0, left.updatedAt ?? 0);
                const rightActivity = Math.max(right.activeAt ?? 0, right.updatedAt ?? 0);
                return rightActivity - leftActivity;
            });
        if (machinesNeedingHydration.length > 0) {
            let hydrationYield: Promise<void> | null = null;
            const yieldHydrationCohort = () => {
                if (!hydrationYield) hydrationYield = yieldToEventLoop().then(() => { hydrationYield = null; });
                return hydrationYield;
            };
            // Crypto completions in one microtask turn share one inventory
            // publication. Publishing each row synchronously repeats all store
            // selectors and AppShell projections for the whole fleet. A slow
            // decrypt does not hold its already-completed peers, and the owning
            // read rechecks Account/key/row currentness at the actual flush.
            let pendingMachines: Machine[] = [];
            let publication: Promise<void> | null = null;
            const publishHydratedMachine = (machine: Machine): Promise<void> => {
                pendingMachines.push(machine);
                if (!publication) {
                    publication = Promise.resolve().then(() => {
                        const batch = pendingMachines;
                        pendingMachines = [];
                        publication = null;
                        if (shouldContinue()) applyCurrentMachines(batch, false);
                    });
                }
                return publication;
            };
            // Keep this read joined to its InvalidateSync attempt. Display rows
            // are already published; otherwise this older completion could
            // overwrite the outcome of a newer list read.
            const onlineHydration: FetchedMachineRow[] = [];
            const backgroundHydration: FetchedMachineRow[] = [];
            for (const machine of machinesNeedingHydration) {
                (isMachineOnline(readIncumbentRow(machine.id) ?? machine)
                    ? onlineHydration : backgroundHydration).push(machine);
            }
            // Sorting alone lets an offline peer share the last online cohort's
            // key/crypto batch. Finish online content through the same bounded
            // owner before admitting background work to that resource.
            await (async () => {
                for (const cohort of [onlineHydration, backgroundHydration]) {
                    await runTasksWithLimit(cohort.map((machine) => async () => {
                        // Reuse the crypto owner's cooperative release before the
                        // next background open; foreground RPCs do not join this fleet.
                        await yieldHydrationCohort();
                        if (!isMachineCurrent(machine.id)) return null;
                        const decryptedMachine = await decryptMachine(machine);
                        if (!isMachineCurrent(machine.id)) return null;
                        if (decryptedMachine) {
                            await publishHydratedMachine(decryptedMachine);
                        }
                        return decryptedMachine;
                    }), concurrencyLimit);
                }
            })().then(() => {
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

    // Process all machines first, then update state once
    const decryptedResults = await runTasksWithLimit(
        machines.map((machine) => async () => decryptMachine(machine)),
        concurrencyLimit,
    );
    const decryptedMachines = decryptedResults.filter((machine): machine is Machine => Boolean(machine));

    // Prefer SWR-style merges by default: do not drop machines that are missing from a
    // particular refresh response unless the caller opts into a hard replace.
    if (!shouldContinue()) return;
    applyCurrentMachines(decryptedMachines, (params.replace ?? false) && !hasOlderRows && machines.every((machine) => isMachineCurrent(machine.id)));
    if (shouldContinue()) params.onListComplete?.();
    log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
}
