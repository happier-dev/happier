import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { log } from '@/log';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { serverFetch } from '@/sync/http/client';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';

type MachineEncryption = {
    decryptMetadata: (version: number, value: string) => Promise<any>;
    decryptDaemonState: (version: number, value: string) => Promise<any>;
};

type SyncEncryption = {
    decryptEncryptionKeys: (values: readonly string[]) => Promise<Array<Uint8Array | null>>;
    initializeMachines: (machineKeysMap: Map<string, Uint8Array | null>) => Promise<void>;
    getMachineEncryption: (machineId: string) => MachineEncryption | null;
};

const warnedMachineDataEncryptionKeyFailuresByEncryption = new WeakMap<SyncEncryption, Set<string>>();

type MachineReplacementFields = Pick<
    Machine,
    'replacedByMachineId' | 'replacedAt' | 'replacementReason' | 'replacementSource' | 'replacementActorUserId'
>;

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

function hasOwnField(source: object, field: string): boolean {
    return Object.prototype.hasOwnProperty.call(source, field);
}

function readReplacementField<T>(
    source: object,
    field: string,
    current: T | null | undefined,
): T | null {
    if (!hasOwnField(source, field)) return current ?? null;
    return (source as Record<string, T | null | undefined>)[field] ?? null;
}

function readReplacementFieldsFromSocketUpdate(
    update: object,
    existingMachine: Machine | undefined,
): MachineReplacementFields {
    return {
        replacedByMachineId: readReplacementField<string>(update, 'replacedByMachineId', existingMachine?.replacedByMachineId),
        replacedAt: readReplacementField<Machine['replacedAt']>(update, 'replacedAt', existingMachine?.replacedAt),
        replacementReason: readReplacementField<string>(update, 'replacementReason', existingMachine?.replacementReason),
        replacementSource: readReplacementField<string>(update, 'replacementSource', existingMachine?.replacementSource),
        replacementActorUserId: readReplacementField<string>(update, 'replacementActorUserId', existingMachine?.replacementActorUserId),
    };
}

function readReplacementFieldsFromMachineRow(machine: {
    replacedByMachineId?: string | null;
    replacedAt?: number | string | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
}): MachineReplacementFields {
    return {
        replacedByMachineId: machine.replacedByMachineId ?? null,
        replacedAt: machine.replacedAt ?? null,
        replacementReason: machine.replacementReason ?? null,
        replacementSource: machine.replacementSource ?? null,
        replacementActorUserId: machine.replacementActorUserId ?? null,
    };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.trunc(value));
}

function compareMachineHydrationPriority(left: { active: boolean; activeAt: number }, right: { active: boolean; activeAt: number }): number {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return right.activeAt - left.activeAt;
}

function batchMachines(machines: Machine[], batchSize: number): Machine[][] {
    const batches: Machine[][] = [];
    for (let index = 0; index < machines.length; index += batchSize) {
        batches.push(machines.slice(index, index + batchSize));
    }
    return batches;
}

export async function buildUpdatedMachineFromSocketUpdate(params: {
    machineUpdate: any;
    updateSeq: number;
    updateCreatedAt: number;
    existingMachine: Machine | undefined;
    getMachineEncryption: (machineId: string) => MachineEncryption | null;
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
        ...readReplacementFieldsFromSocketUpdate(machineUpdate, existingMachine),
        metadata: existingMachine?.metadata ?? null,
        metadataVersion: existingMachine?.metadataVersion ?? 0,
        daemonState: existingMachine?.daemonState ?? null,
        daemonStateVersion: existingMachine?.daemonStateVersion ?? 0,
    };

    // Get machine-specific encryption (might not exist if machine wasn't initialized)
    const machineEncryption = getMachineEncryption(machineId);
    if (!machineEncryption) {
        console.error(`Machine encryption not found for ${machineId} - cannot decrypt updates`);
        return null;
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
    encryption: SyncEncryption;
    machineDataKeys: Map<string, Uint8Array>;
    request?: (path: string, init: RequestInit) => Promise<Response>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    getExistingMachine?: (machineId: string) => Machine | null | undefined;
    applyMachineDisplayEntries?: (machines: MachineDisplayRenderable[], options?: { replace?: boolean }) => void;
    cachedMachineDisplayEntries?: Record<string, MachineDisplayCacheEntryV1>;
    machineDisplayHydrationConcurrencyLimit?: number;
    machineDisplayEagerHydrationCount?: number;
    machineDisplayBackgroundHydrationMaxRows?: number;
    machineDisplayBackgroundHydrationApplyBatchSize?: number;
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
    const request =
        params.request
        ?? ((path: string, init: RequestInit) => serverFetch(path, init, { includeAuth: false }));
    const syncTuning = loadSyncTuning();
    const concurrencyLimit = normalizePositiveInteger(
        params.machineDisplayHydrationConcurrencyLimit,
        syncTuning.machineDisplayHydrationConcurrencyLimit,
    );
    const eagerHydrationCount = normalizeNonNegativeInteger(
        params.machineDisplayEagerHydrationCount,
        syncTuning.machineDisplayEagerHydrationCount,
    );
    const backgroundHydrationMaxRows = normalizeNonNegativeInteger(
        params.machineDisplayBackgroundHydrationMaxRows,
        syncTuning.machineDisplayBackgroundHydrationMaxRows,
    );
    const hydrationApplyBatchSize = normalizePositiveInteger(
        params.machineDisplayBackgroundHydrationApplyBatchSize,
        syncTuning.machineDisplayBackgroundHydrationApplyBatchSize,
    );
    const shouldContinue = params.shouldContinue ?? (() => true);
    const throwOnError = params.throwOnError === true;

    let response: Response;
    try {
        response = await request('/v1/machines', {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        });
    } catch (error) {
        if (throwOnError) {
            throw error;
        }
        return;
    }

    if (!response.ok) {
        if (throwOnError) {
            throw new Error(`Failed to fetch machines: ${response.status}`);
        }
        return;
    }

    let data: unknown;
    try {
        data = await response.json();
    } catch (error) {
        if (throwOnError) {
            throw error;
        }
        return;
    }
    const machines = data as Array<{
        id: string;
        metadata: string;
        metadataVersion: number;
        daemonState?: string | null;
        daemonStateVersion?: number;
        dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
        seq: number;
        active: boolean;
        activeAt: number; // Changed from lastActiveAt
        revokedAt?: number | null;
        replacedByMachineId?: string | null;
        replacedAt?: number | string | null;
        replacementReason?: string | null;
        replacementSource?: string | null;
        replacementActorUserId?: string | null;
        createdAt: number;
        updatedAt: number;
    }>;

    if (!shouldContinue()) {
        return;
    }

    // First, collect and decrypt encryption keys for all machines.
    //
    // One batched open, not one call per machine. `decryptEncryptionKeys` is the
    // canonical owner of the native-crypto-worker routing decision, and it sizes that
    // decision on the whole batch: a lone wrapped data-key envelope is ~505 bridge
    // bytes, under the default `minPayloadBytes` (512), so a per-machine call is forced
    // onto the JS reference path (a curve25519 open, plus a second one whenever the
    // account key is stored as a seed) no matter how healthy the native worker is.
    // Batching also lets the JS reference path release the thread between chunks.
    const machineKeysMap = new Map<string, Uint8Array | null>();
    const envelopeMachineIds: string[] = [];
    const envelopes: string[] = [];
    for (const machine of machines) {
        if (typeof machine.dataEncryptionKey !== 'string' || machine.dataEncryptionKey.length === 0) continue;
        envelopeMachineIds.push(machine.id);
        envelopes.push(machine.dataEncryptionKey);
    }
    let decryptedKeys: Array<Uint8Array | null> = [];
    if (envelopes.length > 0) {
        try {
            decryptedKeys = await encryption.decryptEncryptionKeys(envelopes);
        } catch {
            decryptedKeys = envelopes.map(() => null);
        }
    }
    const decryptedKeyByMachineId = new Map<string, Uint8Array | null>();
    for (let index = 0; index < envelopeMachineIds.length; index += 1) {
        decryptedKeyByMachineId.set(envelopeMachineIds[index]!, decryptedKeys[index] ?? null);
    }
    for (const machine of machines) {
        const hasEnvelope = decryptedKeyByMachineId.has(machine.id);
        const decryptedKey = hasEnvelope ? decryptedKeyByMachineId.get(machine.id) ?? null : null;
        if (!decryptedKey && hasEnvelope) {
            warnMachineDataEncryptionKeyDecryptFailureOnce(encryption, machine.id);
            machineKeysMap.set(machine.id, null);
            continue;
        }
        machineKeysMap.set(machine.id, decryptedKey);
        if (decryptedKey) {
            machineDataKeys.set(machine.id, decryptedKey);
        }
    }

    // Initialize machine encryptions
    let machineEncryptionReady = true;
    try {
        await encryption.initializeMachines(machineKeysMap);
    } catch (error) {
        machineEncryptionReady = false;
        console.error('[machinesSnapshot] Failed to initialize machine encryption; continuing with cached/unencrypted machine rows', error);
    }

    if (!shouldContinue()) {
        return;
    }

    const cachedMachineDisplayEntries = params.cachedMachineDisplayEntries ?? {};
    const shouldApplyMachineDisplays = typeof params.applyMachineDisplayEntries === 'function';
    const needsMachineWarmHydration = (machine: typeof machines[number]): boolean => {
        if (cachedMachineDisplayEntries[machine.id]?.metadataVersion !== machine.metadataVersion) {
            return true;
        }
        return typeof machine.daemonState === 'string' && machine.daemonState.length > 0;
    };

    const buildDisplayFromRowAndCache = (machine: typeof machines[number], cachedEntry: MachineDisplayCacheEntryV1 | undefined): MachineDisplayRenderable => ({
        id: machine.id,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        ...readReplacementFieldsFromMachineRow(machine),
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
        machine: typeof machines[number],
        cachedEntry: MachineDisplayCacheEntryV1 | undefined,
        existingMachine: Machine | null | undefined,
    ): Machine => {
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
            ...readReplacementFieldsFromMachineRow(machine),
            metadataVersion: machine.metadataVersion,
            metadata,
            daemonState: hasEncryptedDaemonState ? existingMachine?.daemonState ?? null : null,
            daemonStateVersion: hasEncryptedDaemonState
                ? existingMachine?.daemonStateVersion ?? (machine.daemonStateVersion || 0)
                : (machine.daemonStateVersion || 0),
        });
    };

    const decryptMachine = async (machine: typeof machines[number]): Promise<Machine | null> => {
        const machineEncryption = encryption.getMachineEncryption(machine.id);
        if (!machineEncryption) {
            console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
            return {
                id: machine.id,
                seq: machine.seq,
                createdAt: machine.createdAt,
                updatedAt: machine.updatedAt,
                active: machine.active,
                activeAt: machine.activeAt,
                revokedAt: machine.revokedAt ?? null,
                ...readReplacementFieldsFromMachineRow(machine),
                metadata: null,
                metadataVersion: machine.metadataVersion,
                daemonState: null,
                daemonStateVersion: machine.daemonStateVersion || 0,
            };
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
                ...readReplacementFieldsFromMachineRow(machine),
                metadata,
                metadataVersion: machine.metadataVersion,
                daemonState,
                daemonStateVersion: machine.daemonStateVersion || 0,
            };
        } catch (error) {
            console.error(`Failed to decrypt machine ${machine.id}:`, error);
            return {
                id: machine.id,
                seq: machine.seq,
                createdAt: machine.createdAt,
                updatedAt: machine.updatedAt,
                active: machine.active,
                activeAt: machine.activeAt,
                revokedAt: machine.revokedAt ?? null,
                ...readReplacementFieldsFromMachineRow(machine),
                metadata: null,
                metadataVersion: machine.metadataVersion,
                daemonState: null,
                daemonStateVersion: 0,
            };
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

        const maxWarmHydrationRows = eagerHydrationCount + backgroundHydrationMaxRows;
        const machinesNeedingHydration = machineEncryptionReady && maxWarmHydrationRows > 0
            ? machines
                .filter((machine) => needsMachineWarmHydration(machine))
                .sort(compareMachineHydrationPriority)
                .slice(0, maxWarmHydrationRows)
            : [];
        if (machinesNeedingHydration.length > 0) {
            void runTasksWithLimit(
                machinesNeedingHydration.map((machine) => async () => {
                    if (!shouldContinue()) return null;
                    const decryptedMachine = await decryptMachine(machine);
                    if (!shouldContinue()) return null;
                    return decryptedMachine;
                }),
                concurrencyLimit,
            ).then((decryptedResults) => {
                if (!shouldContinue()) return;
                const hydratedMachines = decryptedResults.filter((machine): machine is Machine => Boolean(machine));
                for (const batch of batchMachines(hydratedMachines, hydrationApplyBatchSize)) {
                    if (!shouldContinue()) return;
                    applyMachines(batch, false);
                }
            }).catch((error) => {
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
