import type { Machine } from '@/sync/domains/state/storageTypes';

export type MachineActivityUpdate = Readonly<Pick<Machine, 'id' | 'active' | 'activeAt'>>;

export type MachineActivityFacts = Readonly<{ active: boolean; activeAt?: number | null }>;
export type MachineActivityPublication = Readonly<{
    machine: MachineActivityFacts;
    activity: MachineActivityFacts;
    projections: readonly (MachineActivityFacts | null | undefined)[];
}>;
type ActivitySlice = { value: MachineActivityFacts; listeners: Set<() => void> };
// Current liveness is state, not an inventory revision or a derived-value cache.
// The admitted row/projection is its key: a different Home, Account or replacement
// row cannot borrow it, and retiring that row retires this index entry as well.
const activitySlices = new WeakMap<object, ActivitySlice>();

/** Rows are immutable content snapshots; live presence readers use this clock. */
export function readMachineActivity(machine: MachineActivityFacts): MachineActivityFacts {
    return activitySlices.get(machine)?.value ?? machine;
}

export function subscribeMachineActivity(machine: MachineActivityFacts, listener: () => void): () => void {
    let slice = activitySlices.get(machine);
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, listeners: new Set() };
        activitySlices.set(machine, slice);
    }
    slice.listeners.add(listener);
    // A carried row may have moved this listener to the current row's slice.
    return () => { slice.listeners.delete(listener); activitySlices.get(machine)?.listeners.delete(listener); };
}

/** Machine-domain ingress updates only this Machine's liveness subscribers. */
export function publishMachineActivity(
    machine: MachineActivityFacts,
    activity: MachineActivityFacts,
    projections: readonly (MachineActivityFacts | null | undefined)[],
): void {
    publishMachineActivities([{ machine, activity, projections }]);
}

/** Commit the arrival's clocks in order before waking each affected reader once. */
export function publishMachineActivities(publications: Iterable<MachineActivityPublication>): void {
    const listeners = new Set<() => void>();
    for (const { machine, activity, projections } of publications) {
        let slice = activitySlices.get(machine);
        if (!slice) {
            slice = { value: { active: machine.active, activeAt: machine.activeAt }, listeners: new Set() };
            activitySlices.set(machine, slice);
        }
        const slices = new Set([slice]);
        for (const projection of projections) {
            if (!projection) continue;
            const existing = activitySlices.get(projection);
            if (existing) slices.add(existing);
            else activitySlices.set(projection, slice);
        }
        for (const target of slices) {
            target.value = activity;
            for (const listener of target.listeners) listeners.add(listener);
        }
    }
    // Every projection observes the same committed fact before any reader wakes.
    for (const listener of listeners) listener();
}

/**
 * A reader that keeps an earlier, fact-equal row in place of the current one (`useActiveMachineFacts` and its
 * siblings) still observes the current row's clock: the held row and its subscribers join the current slice.
 */
export function carryMachineActivity(held: MachineActivityFacts, current: MachineActivityFacts): void {
    if (held === current) return;
    let slice = activitySlices.get(current);
    if (!slice) {
        slice = { value: { active: current.active, activeAt: current.activeAt }, listeners: new Set() };
        activitySlices.set(current, slice);
    }
    const previous = activitySlices.get(held);
    if (previous === slice) return;
    if (previous) for (const listener of previous.listeners) slice.listeners.add(listener);
    activitySlices.set(held, slice);
}

/** A display is another view of this admitted row's clock, not a second clock. */
export function linkMachineActivity(machine: MachineActivityFacts, projection: MachineActivityFacts): void {
    let slice = activitySlices.get(machine);
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, listeners: new Set() };
        activitySlices.set(machine, slice);
    }
    activitySlices.set(projection, slice);
}

const placeholderContent = {
    seq: 0,
    revokedAt: null,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
} as const;

/** A heartbeat supplies presence, never content or access authority. */
export function buildMachineActivityPlaceholder(update: MachineActivityUpdate): Machine {
    return { ...placeholderContent, id: update.id, active: update.active, activeAt: update.activeAt,
        createdAt: update.activeAt, updatedAt: update.activeAt };
}

export function isMachineActivityPlaceholder(machine: Machine): boolean {
    const placeholder = buildMachineActivityPlaceholder(machine);
    return Object.keys(machine).every(key => Object.hasOwn(placeholder, key))
        && Object.entries(placeholderContent).every(([key, value]) => machine[key as keyof Machine] === value);
}
