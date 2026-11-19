import type { Machine } from '@/sync/domains/state/storageTypes';
import { retainMachineRecord } from '@/sync/store/domains/areStoredMachinesEqual';

/**
 * Completed rows wait for the existing crypto cohort boundary, never a new timer.
 *
 * Every store commit re-renders each fleet-wide Machine consumer, so a commit costs work in proportion to the
 * fleet. Publishing every cohort made a cold fleet O(fleet²): QA A's 483 Machines took 192 commits over 115 s.
 * A cohort boundary therefore publishes only once its ready rows at least match everything already published
 * (never fewer than one cohort): the first cohort appears as soon as it opens, later ones in growing batches, and
 * a whole hydration takes a logarithmic number of commits. The tail, and the caller's completion, always publish.
 */
export function createHydrationPublication(params: Readonly<{
    readCurrentMachine: (machineId: string) => Machine | null | undefined;
    isCohortReleased: () => boolean;
    cohortSize: number;
    hasWaitingTasks: () => boolean;
    publish: (machines: Machine[]) => void;
}>) {
    const pending = new Map<string, Readonly<{ machine: Machine; metadataOnly: boolean }>>();
    let scheduled = false;
    let published = 0;
    const isDue = (ready: number): boolean => ready >= Math.max(params.cohortSize, published) || !params.hasWaitingTasks();
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
        if (changed.length === 0) return;
        published += changed.length;
        params.publish(changed);
    };
    const countMetadataOnly = (): number => {
        let count = 0;
        for (const entry of pending.values()) if (entry.metadataOnly) count += 1;
        return count;
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
                if (params.isCohortReleased() && isDue(pending.size)) flush();
            });
        },
        /** Unconditional: the hydration's completion, or a caller that must observe every ready row. */
        flush: () => flush(),
        /** A released cohort boundary publishes once its batch is due. */
        flushDue: () => { if (isDue(pending.size)) flush(); },
        /** Opened names do not wait behind a daemon read once their batch is due, or at the tail. */
        flushMetadata: () => { if (isDue(countMetadataOnly())) flush(true); },
    };
}
