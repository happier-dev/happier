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
    storageMode?: Machine['storageMode'];
    runnerContentKeyBinding?: unknown;
    seq: number;
    active: boolean;
    activeAt: number;
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
}>): Promise<readonly FetchedMachineRow[]> {
    const request =
        params.request
        ?? ((path: string, init: RequestInit) =>
            serverFetch(path, init, { includeAuth: false }));
    const response = await request('/v1/machines', {
        headers: {
            'Authorization': `Bearer ${params.credentials.token}`,
            'Content-Type': 'application/json',
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch machines: ${response.status}`);
    }
    return await response.json() as FetchedMachineRow[];
}

function readMachineIdentityFields(source: MachineIdentityFieldSource): MachineIdentityFields {
    const installationPublicKey = readMachineInstallationPublicKey(source.installationPublicKey);
    const capabilities = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(source.operationProtocolCapabilities);
    const revision = source.operationProtocolCapabilitiesRevision;
    const accepted = capabilities.success && typeof revision === 'number' && Number.isInteger(revision) && revision > 0;
    return {
        kind: MachineKindFromLegacyProjectionSchema.parse(source.kind),
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
        ...(existingMachine?.dataEncryptionKey !== undefined ? { dataEncryptionKey: existingMachine.dataEncryptionKey } : {}),
    };

    // Socket content never widens the current access projection; list refresh owns access changes.
    if (existingMachine?.isShared && existingMachine.access?.accessState !== 'ready') return updatedMachine;
    const projectChildFact = () => {
        if (machineUpdate.devcontainerChild !== undefined
            || (machineUpdate.metadata && machineUpdate.metadata.version > (existingMachine?.metadataVersion ?? 0))) {
            updatedMachine.metadata = projectMachinePublishedMetadataFromRowV1(updatedMachine.metadata, machineUpdate.devcontainerChild);
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
        return updatedMachine;
    }

    // Get machine-specific encryption (might not exist if machine wasn't initialized).
    // We still preserve freshness fields without it so the UI can reflect the
    // latest online/active state while a full machine refresh is pending.
    const machineEncryption = getMachineEncryption(machineId);
    if (!machineEncryption) {
        if (!machineUpdate.metadata) projectChildFact();
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
    return getMachineEncryption(machineId) === machineEncryption ? updatedMachine : null;
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

export async function fetchAndApplyMachines(params: {
    credentials: AuthCredentials;
    /** Persisted custodian Account mode for owner rows without an access projection. */
    expectedAccountMode?: 'plain' | 'e2ee';
    readAccountMode?: () => Promise<'plain' | 'e2ee'>;
    encryption: SyncEncryption | null;
    machineDataKeys: Map<string, MachineDataKeyCacheEntry>;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
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
            && (!requestMachineSnapshot || requestMachineSnapshot[machine.id] === currentMachineSnapshot?.[machine.id]);
        if (!accepted) hasOlderRows = true;
        return accepted;
    });
    let viewerAccountId: string | null = null;
    try { viewerAccountId = parseToken(credentials.token); } catch { /* Historical token-only Plain reads need no content key. */ }
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
    const capturedRows = new Map(machines.map((machine) => [machine.id, machine] as const));
    const incumbentRows = new Map(machines.map((machine) => [machine.id,
        currentMachineSnapshot?.[machine.id] ?? params.getExistingMachine?.(machine.id),
    ] as const));
    const readIncumbentRow = (machineId: string) => params.getMachineSnapshot
        ? params.getMachineSnapshot()[machineId] : params.getExistingMachine?.(machineId);
    const isMachineCurrent = (machineId: string) => {
        const row = capturedRows.get(machineId);
        return shouldContinue() && machineContexts.get(machineId)?.isCurrent() !== false
            && (!(params.getMachineSnapshot || params.getExistingMachine) || readIncumbentRow(machineId) === incumbentRows.get(machineId))
            && Boolean(row && rowIsNotOlder(row));
    };
    const applyCurrentMachines = (incoming: Machine[], replace: boolean) => {
        const current = incoming.filter((machine) => isMachineCurrent(machine.id));
        applyMachines(current, replace && current.length === incoming.length);
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

    // First, collect and decrypt encryption keys for all machines.
    //
    // Unwrap only what this response actually changed. `machineDataKeys` remembers the
    // exact wrapped envelope each plaintext key came from, so an unchanged envelope is
    // reused instead of re-opened: unwrapping is a pure function of (envelope, account
    // content key), and the account content key is fixed for the lifetime of an
    // `Encryption` instance — the cache is cleared with it on a server-scope reset.
    // This matters because a machines refresh is not rare: it fires on new-session
    // screen focus, settings focus, machine screen focus, handoff, resume and
    // foreground, and every one of those used to re-run a curve25519 open per machine.
    //
    // What remains is opened in one batch, not one call per machine.
    // `decryptEncryptionKeys` is the canonical owner of the native-crypto-worker routing
    // decision and sizes it on the whole batch: a lone wrapped data-key envelope is ~505
    // bridge bytes, under the default `minPayloadBytes` (512), so a per-machine call is
    // forced onto the JS reference path (a curve25519 open, plus a second one whenever
    // the account key is stored as a seed) no matter how healthy the native worker is.
    const machineKeysMap = new Map<string, Uint8Array | null>();
    const unavailableMachineIds = new Set<string>();
    const plainMachineIds = new Set<string>();
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
    const reusedKeyByMachineId = new Map<string, Uint8Array>();
    const pendingMachineIds: string[] = [];
    const pendingEnvelopes: string[] = [];
    const machineKeyKinds = machines.map((machine) => {
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
    const freshKeyByMachineId = new Map<string, Uint8Array | null>();
    for (let index = 0; index < pendingMachineIds.length; index += 1) {
        freshKeyByMachineId.set(pendingMachineIds[index]!, pendingDecryptedKeys[index] ?? null);
    }
    const machineById = new Map(machines.map((machine) => [machine.id, machine] as const));
    // Resolve custody for the whole refresh together, including rows relabelled
    // by the Home. Concurrent refreshes share cold reads at the custody owner.
    const runnerTrustByMachineId = new Map(await Promise.all(machines.map(async (machine) => [
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
    let machineEncryptionReady = encryption !== null;
    if (encryption) {
        try {
            await encryption.initializeMachines(machineKeysMap, new Set([...unavailableMachineIds, ...plainMachineIds]), { isMachineCurrent });
        } catch (error) {
            machineEncryptionReady = false;
            console.error('[machinesSnapshot] Failed to initialize machine encryption; continuing with cached/unencrypted machine rows', error);
        }
    }

    if (!shouldContinue()) {
        return;
    }

    const cachedMachineDisplayEntries = params.cachedMachineDisplayEntries ?? {};
    const shouldApplyMachineDisplays = typeof params.applyMachineDisplayEntries === 'function';
    const needsMachineWarmHydration = (machine: typeof machines[number]): boolean => {
        if (plainMachineIds.has(machine.id) || unavailableMachineIds.has(machine.id)) {
            return false;
        }
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
        if (unavailableMachineIds.has(machine.id) || !machineEncryptionReady || !encryption.getMachineEncryption(machine.id)) {
            return createLockedMachineView(machine, 'decryption_failed');
        }
        const hasEncryptedDaemonState = typeof machine.daemonState === 'string' && machine.daemonState.length > 0;
        // Keep decrypted capabilities and their version while a fresh envelope is pending.
        // The availability checks above still fail closed when encryption or trust is unavailable.
        const canReuseContent = !machine.isShared || (existingMachine?.access?.accessState === 'ready'
            && existingMachine.dataEncryptionKey === machine.dataEncryptionKey);
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
            ...(existingMachine?.storageMode === 'e2ee' && existingMachine.availability
                ? { availability: existingMachine.availability } : {}),
        });
    };

    const decryptMachine = async (machine: typeof machines[number]): Promise<Machine | null> => {
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
            void runTasksWithLimit(
                machinesNeedingHydration.map((machine) => async () => {
                    if (!isMachineCurrent(machine.id)) return null;
                    const decryptedMachine = await decryptMachine(machine);
                    if (!isMachineCurrent(machine.id)) return null;
                    if (decryptedMachine) {
                        applyCurrentMachines([decryptedMachine], false);
                    }
                    return decryptedMachine;
                }),
                concurrencyLimit,
            ).catch((error) => {
                console.error('[machinesSnapshot] Background hydration failed', error);
            });
        }

        log.log(`🖥️ fetchMachines completed - rendered ${displayEntries.length} machine display rows before selective hydration`);
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
    log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
}
