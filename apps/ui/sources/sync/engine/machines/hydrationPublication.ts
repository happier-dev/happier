import type { Machine } from '@/sync/domains/state/storageTypes';
import { retainMachineRecord } from '@/sync/store/domains/areStoredMachinesEqual';

/** Completed rows wait for the existing crypto cohort boundary, never a new timer. */
export function createHydrationPublication(params: Readonly<{
    readCurrentMachine: (machineId: string) => Machine | null | undefined;
    isCohortReleased: () => boolean;
    cohortSize: number;
    hasWaitingTasks: () => boolean;
    publish: (machines: Machine[]) => void;
}>) {
    const pending = new Map<string, Readonly<{ machine: Machine; metadataOnly: boolean }>>();
    let scheduled = false;
    const flush = (metadataOnly = false): void => {
        const changed: Machine[] = [];
        for (const [id, entry] of pending) {
            if (metadataOnly && !entry.metadataOnly) continue;
            pending.delete(id);
            const machine = entry.machine;
            const previous = params.readCurrentMachine(machine.id);
            const retained = retainMachineRecord(previous, machine);
            if (retained !== previous) changed.push(retained);
        }
        if (changed.length > 0) params.publish(changed);
    };
    return {
        enqueue(machine: Machine, metadataOnly = false): void {
            pending.set(machine.id, { machine, metadataOnly });
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => {
                scheduled = false;
                // Prefer the next existing cohort yield. At the tail, ready
                // peers must still publish while another decode remains held.
                if (params.isCohortReleased() && (pending.size >= params.cohortSize || !params.hasWaitingTasks())) flush();
            });
        },
        flush: () => flush(),
        flushMetadata: () => flush(true),
    };
}
