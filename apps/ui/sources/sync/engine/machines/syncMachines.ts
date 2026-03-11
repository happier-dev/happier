import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { log } from '@/log';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { serverFetch } from '@/sync/http/client';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { MachineDisplayCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';

type MachineEncryption = {
    decryptMetadata: (version: number, value: string) => Promise<any>;
    decryptDaemonState: (version: number, value: string) => Promise<any>;
};

type SyncEncryption = {
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeMachines: (machineKeysMap: Map<string, Uint8Array | null>) => Promise<void>;
    getMachineEncryption: (machineId: string) => MachineEncryption | null;
};

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
    /**
     * When true, drop any locally-cached machines that are missing from the
     * latest fetch response.
     *
     * Defaults to false to keep machine lists stable during transient server
     * inconsistencies (SWR-style) and to avoid confusing UI flicker.
     */
    replace?: boolean;
}): Promise<void> {
    const { credentials, encryption, machineDataKeys, applyMachines } = params;
    const request =
        params.request
        ?? ((path: string, init: RequestInit) => serverFetch(path, init, { includeAuth: false }));
    const concurrencyLimit = Math.max(1, Math.trunc(params.machineDisplayHydrationConcurrencyLimit ?? 4));

    let response: Response;
    try {
        response = await request('/v1/machines', {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        });
    } catch (error) {
        console.error('Failed to fetch machines:', error);
        return;
    }

    if (!response.ok) {
        console.error(`Failed to fetch machines: ${response.status}`);
        return;
    }

    let data: unknown;
    try {
        data = await response.json();
    } catch (error) {
        console.error('Failed to parse machines response:', error);
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
        createdAt: number;
        updatedAt: number;
    }>;

    // First, collect and decrypt encryption keys for all machines
    const machineKeysMap = new Map<string, Uint8Array | null>();
    const keyResults = await runTasksWithLimit(
        machines.map((machine) => async () => {
            if (!machine.dataEncryptionKey) {
                return { machineId: machine.id, decryptedKey: null as Uint8Array | null, hasEnvelope: false };
            }
            try {
                const decryptedKey = await encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                return { machineId: machine.id, decryptedKey, hasEnvelope: true };
            } catch {
                return { machineId: machine.id, decryptedKey: null as Uint8Array | null, hasEnvelope: true };
            }
        }),
        concurrencyLimit,
    );
    for (const result of keyResults) {
        if (!result.decryptedKey && result.hasEnvelope) {
            warnMachineDataEncryptionKeyDecryptFailureOnce(encryption, result.machineId);
            machineKeysMap.set(result.machineId, null);
            continue;
        }
        machineKeysMap.set(result.machineId, result.decryptedKey);
        if (result.decryptedKey) {
            machineDataKeys.set(result.machineId, result.decryptedKey);
        }
    }

    // Initialize machine encryptions
    await encryption.initializeMachines(machineKeysMap);

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
        return ({
        id: machine.id,
        seq: machine.seq,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        metadataVersion: machine.metadataVersion,
        metadata: cachedEntry?.metadataVersion === machine.metadataVersion
            ? {
                displayName: cachedEntry.displayName ?? null,
                host: cachedEntry.host ?? null,
                homeDir: cachedEntry.homeDir ?? null,
            }
            : null,
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
            return null;
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
                metadata: null,
                metadataVersion: machine.metadataVersion,
                daemonState: null,
                daemonStateVersion: 0,
            };
        }
    };

    if (shouldApplyMachineDisplays) {
        const displayEntries = machines.map((machine) => buildDisplayFromRowAndCache(machine, cachedMachineDisplayEntries[machine.id]));
        params.applyMachineDisplayEntries!(displayEntries, { replace: true });
        applyMachines(
            machines.map((machine) =>
                buildMachineFromRowAndCache(
                    machine,
                    cachedMachineDisplayEntries[machine.id],
                    params.getExistingMachine?.(machine.id),
                )),
            params.replace ?? false,
        );

        const machinesNeedingHydration = machines.filter((machine) => needsMachineWarmHydration(machine));
        if (machinesNeedingHydration.length > 0) {
            void runTasksWithLimit(
                machinesNeedingHydration.map((machine) => async () => {
                    const decryptedMachine = await decryptMachine(machine);
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
