import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

import type { MachineDisplayCacheEntryV1 } from './warmCachePersistence';

const EMPTY_MACHINE_DISPLAY_CACHE_ENTRIES: Record<string, never> = {};

export function buildMachineDisplayRenderableFromCacheEntry(entry: MachineDisplayCacheEntryV1): MachineDisplayRenderable {
    return {
        id: entry.machineId,
        updatedAt: entry.updatedAt,
        active: entry.active,
        activeAt: entry.activeAt,
        revokedAt: entry.revokedAt,
        replacedByMachineId: entry.replacedByMachineId ?? null,
        replacedAt: entry.replacedAt ?? null,
        replacementReason: entry.replacementReason ?? null,
        replacementSource: entry.replacementSource ?? null,
        replacementActorUserId: entry.replacementActorUserId ?? null,
        ...(entry.lockedReason ? {
            availability: { kind: 'locked' as const, reason: entry.lockedReason },
        } : {}),
        metadataVersion: entry.metadataVersion,
        metadata: {
            displayName: entry.displayName ?? null,
            host: entry.host ?? null,
            homeDir: entry.homeDir ?? null,
        },
    };
}

function shouldPreserveMachineDisplayMetadataFromPreviousEntry(
    machine: MachineDisplayRenderable,
    previousEntry: MachineDisplayCacheEntryV1 | undefined,
): previousEntry is MachineDisplayCacheEntryV1 {
    return machine.metadata == null && Boolean(previousEntry);
}

export function buildMachineDisplayCacheEntryFromRenderable(
    machine: MachineDisplayRenderable,
    previousEntry?: MachineDisplayCacheEntryV1,
): MachineDisplayCacheEntryV1 {
    const preserveMetadata = shouldPreserveMachineDisplayMetadataFromPreviousEntry(machine, previousEntry);
    const nextEntry: MachineDisplayCacheEntryV1 = {
        machineId: machine.id,
        metadataVersion: preserveMetadata ? previousEntry.metadataVersion : machine.metadataVersion,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        replacedByMachineId: machine.replacedByMachineId ?? null,
        replacedAt: machine.replacedAt ?? null,
        replacementReason: machine.replacementReason ?? null,
        replacementSource: machine.replacementSource ?? null,
        replacementActorUserId: machine.replacementActorUserId ?? null,
        lockedReason: machine.availability?.kind === 'locked' ? machine.availability.reason : null,
        displayName: preserveMetadata ? previousEntry.displayName ?? null : machine.metadata?.displayName ?? null,
        host: preserveMetadata ? previousEntry.host ?? null : machine.metadata?.host ?? null,
        homeDir: preserveMetadata ? previousEntry.homeDir ?? null : machine.metadata?.homeDir ?? null,
    };

    return previousEntry && areMachineDisplayCacheEntriesEqual(nextEntry, previousEntry) ? previousEntry : nextEntry;
}

function areMachineDisplayCacheEntriesEqual(
    nextEntry: MachineDisplayCacheEntryV1,
    previousEntry: MachineDisplayCacheEntryV1,
): boolean {
    return (
        nextEntry.metadataVersion === previousEntry.metadataVersion
        && nextEntry.updatedAt === previousEntry.updatedAt
        && nextEntry.active === previousEntry.active
        && nextEntry.activeAt === previousEntry.activeAt
        && nextEntry.revokedAt === previousEntry.revokedAt
        && nextEntry.replacedByMachineId === previousEntry.replacedByMachineId
        && nextEntry.replacedAt === previousEntry.replacedAt
        && nextEntry.replacementReason === previousEntry.replacementReason
        && nextEntry.replacementSource === previousEntry.replacementSource
        && nextEntry.replacementActorUserId === previousEntry.replacementActorUserId
        && nextEntry.lockedReason === previousEntry.lockedReason
        && nextEntry.displayName === previousEntry.displayName
        && nextEntry.host === previousEntry.host
        && nextEntry.homeDir === previousEntry.homeDir
    );
}

function countOwnEntries(record: Readonly<Record<string, unknown>>): number {
    let count = 0;
    for (const key in record) {
        if (Object.prototype.hasOwnProperty.call(record, key)) count += 1;
    }
    return count;
}

export function buildMachineDisplayCacheEntriesFromRenderables(
    machines: Record<string, MachineDisplayRenderable>,
    previousEntries?: Record<string, MachineDisplayCacheEntryV1>,
): Record<string, MachineDisplayCacheEntryV1> {
    const machineIds = Object.keys(machines);
    if (machineIds.length === 0) {
        return previousEntries && Object.keys(previousEntries).length === 0
            ? previousEntries
            : EMPTY_MACHINE_DISPLAY_CACHE_ENTRIES;
    }

    if (!previousEntries) {
        const nextEntries: Record<string, MachineDisplayCacheEntryV1> = {};
        for (const machineId of machineIds) {
            nextEntries[machineId] = buildMachineDisplayCacheEntryFromRenderable(machines[machineId]!);
        }
        return nextEntries;
    }

    let nextEntries = previousEntries;
    let didChange = false;
    let addedCount = 0;
    for (const machineId of machineIds) {
        const machine = machines[machineId]!;
        const previousEntry = previousEntries[machineId];
        const nextEntry = buildMachineDisplayCacheEntryFromRenderable(machine, previousEntry);
        if (!previousEntry) addedCount += 1;
        if (!previousEntry || !areMachineDisplayCacheEntriesEqual(nextEntry, previousEntry)) {
            if (!didChange) {
                nextEntries = { ...previousEntries };
                didChange = true;
            }
            nextEntries[machineId] = nextEntry;
        }
    }

    if (addedCount > 0 || countOwnEntries(previousEntries) !== machineIds.length) {
        if (!didChange) {
            nextEntries = { ...previousEntries };
            didChange = true;
        }
        for (const previousMachineId in previousEntries) {
            if (
                Object.prototype.hasOwnProperty.call(previousEntries, previousMachineId)
                && machines[previousMachineId] === undefined
            ) {
                delete nextEntries[previousMachineId];
            }
        }
    }

    return didChange ? nextEntries : previousEntries;
}
