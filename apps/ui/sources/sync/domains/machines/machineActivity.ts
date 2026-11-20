import type { Machine } from '@/sync/domains/state/storageTypes';

export type MachineActivityUpdate = Readonly<Pick<Machine, 'id' | 'active' | 'activeAt'>>;

export type MachineActivityValue = Readonly<{ active: boolean; activeAt?: number | null }>;
/** Client-lifetime presence owned by the admitted Machine record and shared by its projections. */
export type MachineActivityState = { value: MachineActivityValue; answered: boolean; parent?: MachineActivityState };
export type MachineActivityFacts = MachineActivityValue & { activity?: MachineActivityState };
export type MachineActivityPublication = Readonly<{
    machine: MachineActivityFacts;
    activity: MachineActivityFacts;
    projections: readonly (MachineActivityFacts | null | undefined)[];
}>;
type ActivitySlice = MachineActivityState;
type ActivitySubscription = Readonly<{ listener: () => void; markChanged?: () => void }>;
// Only listeners are indexed. Presence and its answer live on the Machine record.
const activitySubscriptions = new WeakMap<ActivitySlice, Set<ActivitySubscription>>();
function subscriptions(slice: ActivitySlice): Set<ActivitySubscription> {
    let current = activitySubscriptions.get(slice);
    if (!current) activitySubscriptions.set(slice, current = new Set());
    return current;
}
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
 * reader's sampled clock can lag), re-arms the one timer; it stops after firing once. The timer uses wall
 * time for its delay: a held reader's older sample must not postpone the already-established deadline.
 */
let presenceLapseArmedFromMs = Number.NEGATIVE_INFINITY;
export function noteMachinePresenceLapse(atMs: number, nowMs: number): void {
    if (atMs <= presenceLapsePublishedAtMs || atMs > nextPresenceLapseAtMs
        || (atMs === nextPresenceLapseAtMs && nowMs <= presenceLapseArmedFromMs)) return;
    nextPresenceLapseAtMs = atMs;
    presenceLapseArmedFromMs = nowMs;
    if (presenceLapseTimer !== null) clearTimeout(presenceLapseTimer);
    presenceLapseTimer = setTimeout(publishPresenceLapse, Math.max(0, atMs - Date.now()));
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
    const slice = machine.activity;
    return slice ? resolveActivitySlice(slice).value : machine;
}

/** Warm projections can carry a retained active bit before any live presence answer. */
export function readMachinePresenceAnswer(machine: MachineActivityFacts): boolean {
    const slice = machine.activity;
    return slice ? resolveActivitySlice(slice).answered : false;
}

/** Forward every linked projection when its admitted row is carried to a replacement. */
function resolveActivitySlice(slice: ActivitySlice): ActivitySlice {
    let root = slice;
    while (root.parent) root = root.parent;
    let current = slice;
    while (current.parent && current.parent !== root) {
        const parent = current.parent;
        current.parent = root;
        current = parent;
    }
    return root;
}

function ensureActivitySlice(machine: MachineActivityFacts): ActivitySlice {
    let slice = machine.activity;
    if (!slice) {
        slice = { value: { active: machine.active, activeAt: machine.activeAt }, answered: false };
        machine.activity = slice;
    }
    return resolveActivitySlice(slice);
}

function joinActivityProjection(slice: ActivitySlice, projection: MachineActivityFacts): void {
    const existing = projection.activity;
    const previous = existing ? resolveActivitySlice(existing) : undefined;
    if (previous && previous !== slice) {
        previous.parent = slice;
        for (const subscription of subscriptions(previous)) subscriptions(slice).add(subscription);
        subscriptions(previous).clear();
    }
    if (!existing) projection.activity = slice;
}

export function subscribeMachineActivity(machine: MachineActivityFacts, listener: () => void, markChanged?: () => void): () => void {
    const slice = ensureActivitySlice(machine);
    const subscription: ActivitySubscription = { listener, markChanged };
    subscriptions(slice).add(subscription);
    return () => { subscriptions(resolveActivitySlice(slice)).delete(subscription); };
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
        const slice = ensureActivitySlice(machine);
        if (!slice.answered || slice.value.active !== activity.active
            || ((machine as Readonly<{ presenceProtocolVersion?: 1 }>).presenceProtocolVersion !== 1 && slice.value.activeAt !== activity.activeAt)) {
            presenceChanged = true;
        }
        for (const projection of projections) {
            if (!projection) continue;
            joinActivityProjection(slice, projection);
        }
        slice.value = { active: activity.active, activeAt: activity.activeAt };
        slice.answered = true;
        for (const subscription of subscriptions(slice)) {
            subscription.markChanged?.();
            listeners.add(subscription.listener);
        }
    }
    if (presenceChanged) presenceRevision += 1;
    // Every projection observes the same committed fact before any reader wakes.
    for (const listener of listeners) listener();
}

/** A display is another view of this admitted row's clock, not a second clock. */
export function linkMachineActivity(machine: MachineActivityFacts, projection: MachineActivityFacts): void {
    joinActivityProjection(ensureActivitySlice(machine), projection);
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
    return Object.keys(machine).every(key => key === 'activity' || Object.hasOwn(placeholder, key))
        && Object.entries(placeholderContent).every(([key, value]) => machine[key as keyof Machine] === value);
}
