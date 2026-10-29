import type { MachineResourcesSnapshot } from '@happier-dev/protocol';

export type MachineResourcesFetchStatus = 'idle' | 'loading' | 'ready' | 'error';

export type MachineResourcesStateEntry = Readonly<{
    snapshot: MachineResourcesSnapshot | null;
    status: MachineResourcesFetchStatus;
    fetchedAt: number;
}>;

export type MachineResourcesStoreState = Readonly<{
    entriesByMachineId: ReadonlyMap<string, MachineResourcesStateEntry>;
}>;

export type MachineResourcesStore = Readonly<{
    getState: () => MachineResourcesStoreState;
    subscribe: (listener: () => void) => () => void;
    getEntry: (machineId: string) => MachineResourcesStateEntry;
    markLoading: (machineId: string) => boolean;
    mergeSnapshot: (machineId: string, snapshot: MachineResourcesSnapshot) => boolean;
    markError: (machineId: string) => boolean;
}>;

export const IDLE_MACHINE_RESOURCES_ENTRY: MachineResourcesStateEntry = Object.freeze({
    snapshot: null,
    status: 'idle',
    fetchedAt: 0,
});

/**
 * Latest machine-resource snapshot per machine, pulled on demand from each daemon. Purely
 * in-memory: every fetch returns one fresh sample, so there is nothing to persist and no
 * history to keep. Follows the module-scope store + `useSyncExternalStore` convention of
 * `actionOperationStore` rather than the persisted storage domain.
 */
export function createMachineResourcesStore(): MachineResourcesStore {
    let entriesByMachineId = new Map<string, MachineResourcesStateEntry>();
    const listeners = new Set<() => void>();

    const publish = (next: Map<string, MachineResourcesStateEntry>): void => {
        entriesByMachineId = next;
        for (const listener of listeners) listener();
    };

    return {
        getState: () => ({ entriesByMachineId }),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getEntry: (machineId) => entriesByMachineId.get(machineId) ?? IDLE_MACHINE_RESOURCES_ENTRY,
        markLoading: (machineId) => {
            const existing = entriesByMachineId.get(machineId);
            if (existing?.status === 'loading') return false;
            const next = new Map(entriesByMachineId);
            next.set(machineId, { snapshot: existing?.snapshot ?? null, status: 'loading', fetchedAt: existing?.fetchedAt ?? 0 });
            publish(next);
            return true;
        },
        mergeSnapshot: (machineId, snapshot) => {
            const existing = entriesByMachineId.get(machineId);
            if (existing?.status === 'ready' && existing.snapshot === snapshot) return false;
            const next = new Map(entriesByMachineId);
            next.set(machineId, { snapshot, status: 'ready', fetchedAt: Date.now() });
            publish(next);
            return true;
        },
        markError: (machineId) => {
            const existing = entriesByMachineId.get(machineId);
            if (existing?.status === 'error') return false;
            const next = new Map(entriesByMachineId);
            next.set(machineId, { snapshot: existing?.snapshot ?? null, status: 'error', fetchedAt: Date.now() });
            publish(next);
            return true;
        },
    };
}

export const machineResourcesStore = createMachineResourcesStore();

export function readMachineResourcesEntry(machineId: string): MachineResourcesStateEntry {
    return machineResourcesStore.getEntry(machineId);
}
