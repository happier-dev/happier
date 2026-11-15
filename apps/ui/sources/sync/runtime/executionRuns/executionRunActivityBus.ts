import {
    normalizeSessionAddress,
    sessionAddressKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ExecutionRunMachineActivityEphemeralV1Schema } from '@happier-dev/protocol/execution/runs/activityV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * What the producer knows about the notification.
 *
 * `runId` is present when the producer observed one exact Run — the wire
 * `execution-run-updated` ephemeral carries the Run, and every Run mutation
 * names its target. A Session-level consumer ignores it; a surface mounted on
 * one exact Run uses it so a sibling Run's activity does not refetch it. `null`
 * means "unknown", and every listener then refreshes.
 */
export type ExecutionRunActivityNotification = Readonly<{
    runId: string | null;
}>;

type Listener = (notification: ExecutionRunActivityNotification) => void;

const UNKNOWN_RUN_NOTIFICATION: ExecutionRunActivityNotification = Object.freeze({ runId: null });

export type ExecutionRunActivityAddress = SessionAddress | Readonly<{ serverId: string; machineId: string }>;
function activityAddressKey(address: ExecutionRunActivityAddress): string {
    return 'sessionId' in address ? sessionAddressKey(address) : JSON.stringify(['machine', address.serverId, address.machineId]);
}
function normalizeActivityAddress(address: ExecutionRunActivityAddress): ExecutionRunActivityAddress | null {
    if ('sessionId' in address) return normalizeSessionAddress(address.serverId, address.sessionId);
    const serverId = address.serverId.trim();
    const machineId = address.machineId.trim();
    return serverId && machineId ? { serverId, machineId } : null;
}
const listenersByAddress = new Map<string, { address: ExecutionRunActivityAddress; listeners: Set<Listener> }>();

const EMPTY_RUNNING_RUNS: readonly ExecutionRunPublicState[] = Object.freeze([]);
export type RunningExecutionRunRosterSnapshot = Readonly<{
    /** The Session's running Runs. */
    runs: readonly ExecutionRunPublicState[];
    /** Whether the last settled list held any Run (any status): the Session's historical Run support. */
    hasRuns: boolean;
    loading: boolean;
    failed: boolean;
}>;
const UNREAD_ROSTER: RunningExecutionRunRosterSnapshot = Object.freeze({ runs: EMPTY_RUNNING_RUNS, hasRuns: false, loading: true, failed: false });
const EMPTY_ROSTER: RunningExecutionRunRosterSnapshot = Object.freeze({ runs: EMPTY_RUNNING_RUNS, hasRuns: false, loading: false, failed: false });
/** Reads the Session's listed Runs (every status); `null` when the list is unavailable. */
type RosterRead = () => Promise<readonly ExecutionRunPublicState[] | null>;
type Roster = {
    snapshot: RunningExecutionRunRosterSnapshot;
    listeners: Set<() => void>;
    read: RosterRead;
    request: object | null;
    invalidated: boolean;
    dispose: () => void;
};

// Demanded projections only: the host list remains authoritative. Every mounted
// consumer of one address shares its read and immutable snapshot; the last
// subscriber releases it, and a later mount starts with a new baseline.
const rostersBySessionAddress = new Map<string, Roster>();

function publishRoster(roster: Roster, status: Readonly<{ loading: boolean; failed: boolean }>, runs = roster.snapshot.runs,
    hasRuns = roster.snapshot.hasRuns): void {
    const previous = roster.snapshot;
    let next = runs;
    if (runs !== previous.runs) {
        const previousById = new Map(previous.runs.map((run) => [run.runId, run]));
        next = runs.map((run) => {
            const previous = previousById.get(run.runId);
            return previous && JSON.stringify(previous) === JSON.stringify(run) ? previous : run;
        });
    }
    const unchangedRuns = next === previous.runs
        || next.length === previous.runs.length && next.every((run, index) => run === previous.runs[index]);
    if (unchangedRuns && hasRuns === previous.hasRuns && status.loading === previous.loading && status.failed === previous.failed) return;
    roster.snapshot = { ...status, hasRuns, runs: unchangedRuns ? previous.runs : next.length > 0 ? next : EMPTY_RUNNING_RUNS };
    for (const listener of [...roster.listeners]) listener();
}

function refreshRoster(key: string, roster: Roster): void {
    if (rostersBySessionAddress.get(key) !== roster) return;
    if (roster.request) {
        roster.invalidated = true;
        return;
    }
    const request = {};
    roster.request = request;
    roster.invalidated = false;
    void (async () => {
        try {
            const listed = await roster.read();
            if (rostersBySessionAddress.get(key) !== roster || roster.request !== request) return;
            // A failed/unavailable read cannot prove that the last-known runs
            // finished. Reconnect, activity or explicit refresh will catch up.
            publishRoster(roster, { loading: false, failed: listed === null },
                listed === null ? roster.snapshot.runs : listed.filter(run => run.status === 'running'),
                listed === null ? roster.snapshot.hasRuns : listed.length > 0);
        } catch {
            if (rostersBySessionAddress.get(key) === roster && roster.request === request) {
                publishRoster(roster, { loading: false, failed: true });
            }
        } finally {
            if (rostersBySessionAddress.get(key) === roster && roster.request === request) {
                roster.request = null;
                if (roster.invalidated) refreshRoster(key, roster);
            }
        }
    })();
}

export function readRunningExecutionRunRoster(address: SessionAddress | null): readonly ExecutionRunPublicState[] {
    return readRunningExecutionRunRosterSnapshot(address).runs;
}

export function readRunningExecutionRunRosterSnapshot(address: SessionAddress | null): RunningExecutionRunRosterSnapshot {
    return address ? rostersBySessionAddress.get(sessionAddressKey(address))?.snapshot ?? UNREAD_ROSTER : EMPTY_ROSTER;
}

export function refreshRunningExecutionRunRoster(address: SessionAddress): void {
    const key = sessionAddressKey(address);
    const roster = rostersBySessionAddress.get(key);
    if (roster) refreshRoster(key, roster);
}

export function subscribeRunningExecutionRunRoster(
    address: SessionAddress,
    listener: () => void,
    read: RosterRead,
    /**
     * True only when this reader is proven to receive the Session's live Run
     * hints (`execution-run-updated`). The server withholds them from finite
     * publication recipients, whose only wake is a published content page.
     * Absent or false keeps those pages as a re-read.
     */
    receivesLiveRunActivity?: () => boolean,
): () => void {
    const key = sessionAddressKey(address);
    let roster = rostersBySessionAddress.get(key);
    if (!roster) {
        const created: Roster = {
            snapshot: UNREAD_ROSTER, listeners: new Set(), read,
            request: null, invalidated: false, dispose: () => {},
        };
        roster = created;
        rostersBySessionAddress.set(key, created);
        // Subscribe before reading so an event during the baseline schedules
        // one follow-up read rather than disappearing into the baseline gap.
        const unsubscribeActivity = subscribeExecutionRunActivity(address, () => refreshRoster(key, created));
        const unsubscribeCatchUp = subscribeHomeAccountChange((event) => {
            // Exact unrelated pages cannot change this Session's admission.
            // Own-Session and coarse wakes may change access/publication, even
            // when live Run ephemerals are correctly suppressed for the reader.
            if (event.entityIds !== undefined && !event.entityIds.includes(address.sessionId)) return;
            // Own-Session content pages (messages, metadata, agent state) arrive
            // throughout a turn. A reader that receives live Run hints is already
            // told about Run changes (and catches up on reconnect), so its content
            // pages read nothing. Collaborators keep them: a published page is
            // their only signal that a Run became visible or changed.
            if (event.changeKinds?.length && event.changeKinds.every(kind => kind === 'session')
                && receivesLiveRunActivity?.() === true) return;
            if (areServerProfileIdentifiersEquivalent(event.serverId, address.serverId)) refreshRoster(key, created);
        }, { reconnect: 'refresh' });
        const unsubscribeCredentials = subscribeHomeCredentialChange((event) => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, address.serverId)) return;
            // The existing credential owner retires Account data synchronously.
            // An old request may finish, but can no longer publish its rows.
            created.request = null;
            created.invalidated = false;
            publishRoster(created, { loading: false, failed: true }, EMPTY_RUNNING_RUNS, false);
            if (event.kind === 'credentials_set') refreshRoster(key, created);
        });
        created.dispose = () => {
            unsubscribeActivity();
            unsubscribeCatchUp();
            unsubscribeCredentials();
        };
    }
    const current = roster;
    current.listeners.add(listener);
    if (current.listeners.size === 1) refreshRoster(key, current);
    return () => {
        current.listeners.delete(listener);
        if (current.listeners.size > 0 || rostersBySessionAddress.get(key) !== current) return;
        rostersBySessionAddress.delete(key);
        current.dispose();
    };
}

export function notifyExecutionRunActivity(
    address: ExecutionRunActivityAddress,
    notification: ExecutionRunActivityNotification = UNKNOWN_RUN_NOTIFICATION,
): void {
    const normalizedAddress = normalizeActivityAddress(address);
    if (!normalizedAddress) return;

    const listeners = listenersByAddress.get(activityAddressKey(normalizedAddress))?.listeners;
    if (!listeners || listeners.size === 0) return;

    // Defensive copy: listeners may add/remove subscriptions while handling the notification.
    for (const listener of Array.from(listeners)) {
        try {
            listener(notification);
        } catch {
            // ignore listener errors
        }
    }
}

/**
 * Both Home sockets normalize content-free invalidation hints here. Do not
 * accept pushed Run state into the roster: its list reader owns that parsing.
 */
export function notifyExecutionRunActivityFromUpdate(
    serverId: string | null | undefined,
    update: unknown,
): void {
    if (update && typeof update === 'object' && 'machineId' in update) {
        const parsed = ExecutionRunMachineActivityEphemeralV1Schema.safeParse(update);
        if (parsed.success && typeof serverId === 'string') notifyExecutionRunActivity({ serverId, machineId: parsed.data.machineId }, { runId: parsed.data.runId });
        return;
    }
    if (!update || typeof update !== 'object'
        || !('type' in update) || update.type !== 'execution-run-updated'
        || !('sessionId' in update) || typeof update.sessionId !== 'string') return;
    const address = normalizeSessionAddress(serverId, update.sessionId);
    if (!address) return;
    const run = 'run' in update ? update.run : null;
    const runId = run && typeof run === 'object' && 'runId' in run && typeof run.runId === 'string'
        ? run.runId.trim() || null : null;
    notifyExecutionRunActivity(address, { runId });
}

/** Ephemerals have no replay cursor: every connection catches up demanded addresses. */
export function notifyExecutionRunActivityReconnect(serverId: string): void {
    for (const { address } of [...listenersByAddress.values()]) {
        if (areServerProfileIdentifiersEquivalent(address.serverId, serverId)) notifyExecutionRunActivity(address);
    }
}

export function subscribeExecutionRunActivity(address: ExecutionRunActivityAddress, listener: Listener): () => void {
    const normalizedAddress = normalizeActivityAddress(address);
    if (!normalizedAddress) return () => {};

    const key = activityAddressKey(normalizedAddress);
    const entry = listenersByAddress.get(key) ?? { address: normalizedAddress, listeners: new Set<Listener>() };
    entry.listeners.add(listener);
    listenersByAddress.set(key, entry);

    return () => {
        const current = listenersByAddress.get(key);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
            listenersByAddress.delete(key);
        }
    };
}
