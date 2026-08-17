import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { log } from '@/log';
import type { Machine, MachineLockedReason } from '@/sync/domains/state/storageTypes';
import { serverFetch } from '@/sync/http/client';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import {
    decodePlainMachineStoredContent,
    isPlainMachineDataKeyMarker,
} from '@happier-dev/protocol';

type MachineEncryption = {
    decryptMetadata: (version: number, value: string) => Promise<any>;
    decryptDaemonState: (version: number, value: string) => Promise<any>;
};

type SyncEncryption = {
    decryptEncryptionKeys: (values: readonly string[]) => Promise<Array<Uint8Array | null>>;
    initializeMachines: (machineKeysMap: Map<string, Uint8Array | null>) => Promise<void>;
    getMachineEncryption: (machineId: string) => MachineEncryption | null;
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
    | 'replacedByMachineId'
    | 'replacedAt'
    | 'replacementReason'
    | 'replacementSource'
    | 'replacementActorUserId'
    | 'installationId'
    | 'contentPublicKeyFingerprint'
>;

type MachineIdentityFieldSource = Readonly<Partial<MachineIdentityFields>>;

export type FetchedMachineRow = Readonly<{
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState?: string | null;
    daemonStateVersion?: number;
    dataEncryptionKey?: string | null;
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
    contentPublicKeyFingerprint?: string | null;
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
    return {
        replacedByMachineId: source.replacedByMachineId ?? null,
        replacedAt: source.replacedAt ?? null,
        replacementReason: source.replacementReason ?? null,
        replacementSource: source.replacementSource ?? null,
        replacementActorUserId: source.replacementActorUserId ?? null,
        installationId: source.installationId ?? null,
        contentPublicKeyFingerprint: source.contentPublicKeyFingerprint ?? null,
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
        storageMode,
        availability: {
            kind: 'locked',
            reason,
        },
    };
}

function createReadablePlainMachineView(machine: FetchedMachineRow): Machine {
    return {
        id: machine.id,
        seq: machine.seq,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        metadata: machine.metadata
            ? decodePlainMachineStoredContent(machine.metadata) as Machine['metadata']
            : null,
        metadataVersion: machine.metadataVersion,
        daemonState: machine.daemonState
            ? decodePlainMachineStoredContent(machine.daemonState)
            : null,
        daemonStateVersion: machine.daemonStateVersion ?? 0,
        storageMode: 'plain',
        availability: { kind: 'available' },
        ...readMachineIdentityFields(machine),
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
    console.warn(`Failed to decrypt data encryption key for machine ${machineId}; falling back to legacy machine encryption.`);
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
                updatedMachine.metadata = decodePlainMachineStoredContent(metadataUpdate.value) as Machine['metadata'];
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
                updatedMachine.daemonState = decodePlainMachineStoredContent(daemonStateUpdate.value);
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
        return updatedMachine;
    }

    // Get machine-specific encryption (might not exist if machine wasn't initialized).
    // We still preserve freshness fields without it so the UI can reflect the
    // latest online/active state while a full machine refresh is pending.
    const machineEncryption = getMachineEncryption(machineId);
    if (!machineEncryption) {
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

    return updatedMachine;
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
    encryption: SyncEncryption | null;
    machineDataKeys: Map<string, MachineDataKeyCacheEntry>;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    getExistingMachine?: (machineId: string) => Machine | null | undefined;
    applyMachineDisplayEntries?: (machines: MachineDisplayRenderable[], options?: { replace?: boolean }) => void;
    cachedMachineDisplayEntries?: Record<string, MachineDisplayCacheEntryV1>;
    machineDisplayHydrationConcurrencyLimit?: number;
    machineDisplayHydrationMaxRows?: number;
    shouldContinue?: () => boolean;
    /**
     * When true, drop any locally-cached machines that are missing from the
     * latest fetch response.
     *
     * Defaults to false to keep machine lists stable during transient server
     * inconsistencies (SWR-style) and to avoid confusing UI flicker.
     */
    replace?: boolean;
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
    const hydrationMaxRows = Math.max(
        1,
        Math.trunc(params.machineDisplayHydrationMaxRows ?? loadSyncTuning().machineDisplayHydrationMaxRows),
    );
    const shouldContinue = params.shouldContinue ?? (() => true);
    const throwOnError = params.throwOnError === true;

    let machines: readonly FetchedMachineRow[];
    try {
        machines = await fetchMachineRows({
            credentials,
            ...(params.request ? { request: params.request } : {}),
        });
    } catch (error) {
        if (throwOnError) {
            throw error;
        }
        return;
    }

    if (!shouldContinue()) {
        return;
    }

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
    type MachineKeyKind = 'plain' | 'legacy' | 'encrypted' | 'encrypted_unavailable';
    const classifyMachineKey = (machine: FetchedMachineRow): Readonly<{ kind: MachineKeyKind; envelope: string | null }> => {
        if (isPlainMachineDataKeyMarker(machine.dataEncryptionKey)) return { kind: 'plain', envelope: null };
        if (!machine.dataEncryptionKey) return { kind: 'legacy', envelope: null };
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
    for (const result of machineKeyKinds) {
        const reusedKey = reusedKeyByMachineId.get(result.machineId);
        const decryptedKey = reusedKey ?? freshKeyByMachineId.get(result.machineId) ?? null;
        if (!decryptedKey) {
            // A rotated envelope that fails to open — or a machine that moved to plain or
            // legacy storage — must not leave the previous key cached: the next refresh
            // would reuse a key this machine no longer uses.
            machineDataKeys.delete(result.machineId);
        }
        if (!decryptedKey && (result.kind === 'encrypted' || result.kind === 'encrypted_unavailable')) {
            if (encryption) {
                warnMachineDataEncryptionKeyDecryptFailureOnce(encryption, result.machineId);
            } else {
                console.warn(`Account encryption material is unavailable for machine ${result.machineId}.`);
            }
            machineKeysMap.set(result.machineId, null);
            continue;
        }
        if (result.kind === 'plain') continue;
        machineKeysMap.set(result.machineId, decryptedKey);
        if (decryptedKey && result.envelope) {
            machineDataKeys.set(result.machineId, { envelope: result.envelope, dataKey: decryptedKey });
        }
    }

    // Initialize machine encryptions
    let machineEncryptionReady = encryption !== null;
    if (encryption) {
        try {
            await encryption.initializeMachines(machineKeysMap);
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
        if (isPlainMachineDataKeyMarker(machine.dataEncryptionKey)) {
            return false;
        }
        if (cachedMachineDisplayEntries[machine.id]?.metadataVersion !== machine.metadataVersion) {
            return true;
        }
        return typeof machine.daemonState === 'string' && machine.daemonState.length > 0;
    };

    const buildDisplayFromRowAndCache = (machine: FetchedMachineRow, cachedEntry: MachineDisplayCacheEntryV1 | undefined): MachineDisplayRenderable => ({
        id: machine.id,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        ...readMachineIdentityFields(machine),
        metadataVersion: machine.metadataVersion,
        metadata: cachedEntry?.metadataVersion === machine.metadataVersion
            ? {
                displayName: cachedEntry.displayName ?? null,
                host: cachedEntry.host ?? null,
                homeDir: cachedEntry.homeDir ?? null,
            }
            : null,
    });

    const buildMachineFromRowAndCache = (
        machine: FetchedMachineRow,
        cachedEntry: MachineDisplayCacheEntryV1 | undefined,
        existingMachine: Machine | null | undefined,
    ): Machine => {
        if (isPlainMachineDataKeyMarker(machine.dataEncryptionKey)) {
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
        if (!machineEncryptionReady || !encryption.getMachineEncryption(machine.id)) {
            return createLockedMachineView(machine, 'decryption_failed');
        }
        const hasEncryptedDaemonState = typeof machine.daemonState === 'string' && machine.daemonState.length > 0;
        const metadata = cachedEntry?.metadataVersion === machine.metadataVersion && existingMachine?.metadata
            ? {
                ...existingMachine.metadata,
                displayName: cachedEntry.displayName ?? existingMachine.metadata.displayName,
                host: cachedEntry.host ?? existingMachine.metadata.host,
                homeDir: cachedEntry.homeDir ?? existingMachine.metadata.homeDir,
            }
            : null;
        return ({
            id: machine.id,
            seq: machine.seq,
            createdAt: machine.createdAt,
            updatedAt: machine.updatedAt,
            active: machine.active,
            activeAt: machine.activeAt,
            revokedAt: machine.revokedAt ?? null,
            metadataVersion: machine.metadataVersion,
            metadata,
            daemonState: hasEncryptedDaemonState ? existingMachine?.daemonState ?? null : null,
            daemonStateVersion: hasEncryptedDaemonState
                ? existingMachine?.daemonStateVersion ?? (machine.daemonStateVersion || 0)
                : (machine.daemonStateVersion || 0),
            ...readMachineIdentityFields(machine),
        });
    };

    const decryptMachine = async (machine: typeof machines[number]): Promise<Machine | null> => {
        if (isPlainMachineDataKeyMarker(machine.dataEncryptionKey)) {
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

            return {
                id: machine.id,
                seq: machine.seq,
                createdAt: machine.createdAt,
                updatedAt: machine.updatedAt,
                active: machine.active,
                activeAt: machine.activeAt,
                revokedAt: machine.revokedAt ?? null,
                metadata,
                metadataVersion: machine.metadataVersion,
                daemonState,
                daemonStateVersion: machine.daemonStateVersion || 0,
                ...readMachineIdentityFields(machine),
                storageMode: 'e2ee',
                availability: { kind: 'available' },
            };
        } catch (error) {
            console.error(`Failed to decrypt machine ${machine.id}:`, error);
            return createLockedMachineView(machine, 'decryption_failed');
        }
    };

    if (shouldApplyMachineDisplays) {
        const displayEntries = machines.map((machine) => buildDisplayFromRowAndCache(machine, cachedMachineDisplayEntries[machine.id]));
        params.applyMachineDisplayEntries!(displayEntries, { replace: params.replace ?? false });
        applyMachines(
            machines.map((machine) =>
                buildMachineFromRowAndCache(
                    machine,
                    cachedMachineDisplayEntries[machine.id],
                    params.getExistingMachine?.(machine.id),
                )),
            params.replace ?? false,
        );

        const machinesNeedingHydration = machines
            .filter((machine) =>
                isPlainMachineDataKeyMarker(machine.dataEncryptionKey) || machineEncryptionReady)
            .filter((machine) => needsMachineWarmHydration(machine))
            .sort((left, right) => {
                if (left.active !== right.active) return left.active ? -1 : 1;
                const leftActivity = Math.max(left.activeAt ?? 0, left.updatedAt ?? 0);
                const rightActivity = Math.max(right.activeAt ?? 0, right.updatedAt ?? 0);
                return rightActivity - leftActivity;
            })
            .slice(0, hydrationMaxRows);
        if (machinesNeedingHydration.length > 0) {
            void runTasksWithLimit(
                machinesNeedingHydration.map((machine) => async () => {
                    if (!shouldContinue()) return null;
                    const decryptedMachine = await decryptMachine(machine);
                    if (!shouldContinue()) return null;
                    if (decryptedMachine) {
                        applyMachines([decryptedMachine], false);
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
    applyMachines(decryptedMachines, params.replace ?? false);
    log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
}
