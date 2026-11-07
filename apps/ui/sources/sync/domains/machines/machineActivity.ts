import type { Machine } from '@/sync/domains/state/storageTypes';

export type MachineActivityUpdate = Readonly<Pick<Machine, 'id' | 'active' | 'activeAt'>>;

export type MachineActivityFacts = Readonly<{ active: boolean; activeAt?: number | null }>;
export type MachineActivityPublication = Readonly<{
    machine: MachineActivityFacts;
    activity: MachineActivityFacts;
    projections: readonly (MachineActivityFacts | null | undefined)[];
}>;
type ActivitySlice = { value: MachineActivityFacts; subscriptions: Set<ActivitySubscription> };
// One registration. Carried rows copy it across slices, so it records each slice it joined.
type ActivitySubscription = { listener: () => void; slices: Set<ActivitySlice> };
// Current liveness is state, not an inventory revision or a derived-value cache.
// The admitted row/projection is its key: a different Home, Account or replacement
// row cannot borrow it, and retiring that row retires this index entry as well.
const activitySlices = new WeakMap<object, ActivitySlice>();
// Advances only when some Machine's presence answer can change: an arrival that flips `active`, an arrival
// for a Home without the presence fact (its client-side grace restarts), or such a Home's grace lapsing.
// A heartbeat that only moves `activeAt` on a Home that owns presence changes no answer and advances nothing.
let presenceRevision = 0;
// The earliest client-side grace lapse a presence evaluation recorded. The owner publishes it at that
// instant with one timer; readers of the revision never read a clock.
let nextPresenceLapseAtMs = Number.POSITIVE_INFINITY;
let presenceLapseTimer: ReturnType<typeof setTimeout> | null = null;
// A lapse publication at this instant covers every lapse at or before it.
let presenceLapsePublishedAtMs = Number.NEGATIVE_INFINITY;

/** A held decision derived from Machine presence re-derives only when this changes. */
export function readMachinePresenceRevision(): number {
    return presenceRevision;
}

function publishPresenceLapse(): void {
    presenceLapseTimer = null;
    presenceLapsePublishedAtMs = nextPresenceLapseAtMs;
    nextPresenceLapseAtMs = Number.POSITIVE_INFINITY;
    presenceLapseArmedFromMs = Number.NEGATIVE_INFINITY;
    presenceRevision += 1;
}

/**
 * The presence evaluation records when an online row's client-side grace lapses (Homes without the presence
 * fact), at the instant it evaluated. Only an earlier lapse, or the same lapse seen from a later instant (a
 * reader's sampled clock can lag), re-arms the one timer; it stops after firing once. No clock is read here.
 */
let presenceLapseArmedFromMs = Number.NEGATIVE_INFINITY;
export function noteMachinePresenceLapse(atMs: number, nowMs: number): void {
    if (atMs <= presenceLapsePublishedAtMs || atMs > nextPresenceLapseAtMs
        || (atMs === nextPresenceLapseAtMs && nowMs <= presenceLapseArmedFromMs)) return;
    nextPresenceLapseAtMs = atMs;
    presenceLapseArmedFromMs = nowMs;
    if (presenceLapseTimer !== null) clearTimeout(presenceLapseTimer);
    presenceLapseTimer = setTimeout(publishPresenceLapse, Math.max(0, atMs - nowMs));
}

// Process-global lapse timer: the test setup resets it before each test, like other module state.
(globalThis as unknown as { [key: symbol]: Map<string, () => void> | undefined })[Symbol.for('happier.vitest.testResets')]
    ?.set('machineActivity.presenceLapse', () => {
        if (presenceLapseTimer !== null) clearTimeout(presenceLapseTimer);
        presenceLapseTimer = null;
        nextPresenceLapseAtMs = Number.POSITIVE_INFINITY;
        presenceLapseArmedFromMs = Number.NEGATIVE_INFINITY;
        presenceLapsePublishedAtMs = Number.NEGATIVE_INFINITY;
    });

/** Rows are immutable content snapshots; live presence readers use this clock. */
export function readMachineActivity(machine: MachineActivityFacts): MachineActivityFacts {
    return activitySlices.get(machine)?.value ?? machine;
}

export function subscribeMachineActivity(machine: MachineActivityFacts, listener: () => void): () => void {
    let slice = activitySlices.get(machine);
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, subscriptions: new Set() };
        activitySlices.set(machine, slice);
    }
    const subscription: ActivitySubscription = { listener, slices: new Set([slice]) };
    slice.subscriptions.add(subscription);
    return () => {
        for (const joined of subscription.slices) joined.subscriptions.delete(subscription);
        subscription.slices.clear();
    };
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
    let presenceChanged = false;
    for (const { machine, activity, projections } of publications) {
        let slice = activitySlices.get(machine);
        if (!slice) {
            slice = { value: { active: machine.active, activeAt: machine.activeAt }, subscriptions: new Set() };
            activitySlices.set(machine, slice);
        }
        if (slice.value.active !== activity.active
            || ((machine as Readonly<{ presenceProtocolVersion?: 1 }>).presenceProtocolVersion !== 1 && slice.value.activeAt !== activity.activeAt)) {
            presenceChanged = true;
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
            for (const subscription of target.subscriptions) listeners.add(subscription.listener);
        }
    }
    if (presenceChanged) presenceRevision += 1;
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
        slice = { value: { active: current.active, activeAt: current.activeAt }, subscriptions: new Set() };
        activitySlices.set(current, slice);
    }
    const previous = activitySlices.get(held);
    if (previous === slice) return;
    if (previous) {
        for (const subscription of previous.subscriptions) {
            slice.subscriptions.add(subscription);
            subscription.slices.add(slice);
        }
    }
    activitySlices.set(held, slice);
}

/** A display is another view of this admitted row's clock, not a second clock. */
export function linkMachineActivity(machine: MachineActivityFacts, projection: MachineActivityFacts): void {
    let slice = activitySlices.get(machine);
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, subscriptions: new Set() };
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
