import * as React from 'react';

import { log } from '@/log';
import {
    fetchSessionLeavingPage,
    getLeavingSessionDate,
    type SessionLeavingPage,
    type SessionLeavingRule,
} from '@/sync/api/session/apiSessionLeaving';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';

/**
 * The session list's shared loader for the first page of `GET /v2/sessions/leaving`.
 *
 * Demand-driven like the plan resource: the session list mounting is the demand. It reads once when
 * the first consumer mounts, once when the app comes back to the foreground while one is mounted,
 * and once when the Keep stack opens. No timer, no polling. A pin made after the read does not
 * re-read: consumers drop pinned sessions locally (see `useLeavingSessionsView`), so a Keep is one
 * pin write and nothing else. A session crossing into the window is seen at the next foreground.
 *
 * Each date is computed from the row's activity and the response's `rule` with the shared
 * `computeSessionLeavesAt`; nothing stores a date.
 */

export type LeavingSession = Readonly<{ id: string; leavesAt: number }>;

export type LeavingSessionsData = Readonly<{
    rule: SessionLeavingRule;
    /** Server-side count of leaving sessions; the page may hold fewer when it exceeds the route's page. */
    count: number;
    newestLeavesAt: number | null;
    /** Soonest first. */
    sessions: readonly LeavingSession[];
    leavesAtById: ReadonlyMap<string, number>;
}>;

export type LeavingSessionsStatus = 'idle' | 'loading' | 'ready' | 'off' | 'error';

export type LeavingSessionsEntry = Readonly<{
    serverId: string;
    status: LeavingSessionsStatus;
    data: LeavingSessionsData | null;
}>;

const entries = new Map<string, LeavingSessionsEntry>();
const demand = new Map<string, number>();
const inFlight = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const listeners = new Set<() => void>();
let stopForegroundListener: (() => void) | null = null;
let wasRuntimeActive = true;

function activeServerId(): string {
    return getActiveServerSnapshot().serverId;
}

const idleEntries = new Map<string, LeavingSessionsEntry>();

/** One idle object per server, so a snapshot read before the first load stays referentially stable. */
function idleEntry(serverId: string): LeavingSessionsEntry {
    let entry = idleEntries.get(serverId);
    if (!entry) {
        entry = Object.freeze({ serverId, status: 'idle' as const, data: null });
        idleEntries.set(serverId, entry);
    }
    return entry;
}

function publish(serverId: string, next: LeavingSessionsEntry): void {
    const previous = entries.get(serverId);
    if (previous && previous.status === next.status && previous.data === next.data) return;
    entries.set(serverId, next);
    for (const listener of listeners) listener();
}

function toData(page: SessionLeavingPage): LeavingSessionsData {
    const sessions = page.sessions
        .map((row) => ({ id: row.id, leavesAt: getLeavingSessionDate(row, page.rule) }))
        .sort((left, right) => left.leavesAt - right.leavesAt || (left.id < right.id ? -1 : 1));
    return {
        rule: page.rule,
        count: page.count,
        newestLeavesAt: page.newestLeavesAt,
        sessions,
        leavesAtById: new Map(sessions.map((session) => [session.id, session.leavesAt])),
    };
}

/** A re-read with the same facts keeps the previous object, so no consumer re-renders. */
function sameData(left: LeavingSessionsData | null, right: LeavingSessionsData): boolean {
    if (!left) return false;
    if (left.count !== right.count || left.newestLeavesAt !== right.newestLeavesAt) return false;
    if (left.rule.retentionDays !== right.rule.retentionDays
        || left.rule.noticeDays !== right.rule.noticeDays
        || left.rule.floorAt !== right.rule.floorAt) return false;
    if (left.sessions.length !== right.sessions.length) return false;
    return left.sessions.every((session, index) => (
        session.id === right.sessions[index]!.id && session.leavesAt === right.sessions[index]!.leavesAt
    ));
}

function load(serverId: string): Promise<void> {
    const running = inFlight.get(serverId);
    if (running) return running.promise;
    const current = entries.get(serverId) ?? idleEntry(serverId);
    if (current.data === null && current.status !== 'loading') publish(serverId, { ...current, status: 'loading' });
    const controller = new AbortController();
    const promise = (async () => {
        try {
            const result = await fetchSessionLeavingPage(controller.signal);
            if (controller.signal.aborted || activeServerId() !== serverId) return;
            const previous = entries.get(serverId) ?? idleEntry(serverId);
            if (result.kind === 'off') {
                publish(serverId, { serverId, status: 'off', data: null });
                return;
            }
            const next = toData(result.page);
            publish(serverId, { serverId, status: 'ready', data: sameData(previous.data, next) ? previous.data : next });
        } catch (error) {
            if (controller.signal.aborted || activeServerId() !== serverId) return;
            const previous = entries.get(serverId) ?? idleEntry(serverId);
            // Last-known data stays; the foot keeps showing it and the stack offers Retry.
            publish(serverId, { ...previous, status: 'error' });
            log.log(`[retention] leaving sessions read failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (inFlight.get(serverId)?.controller === controller) inFlight.delete(serverId);
        }
    })();
    inFlight.set(serverId, { controller, promise });
    return promise;
}

function handleRuntimeActiveChange(): void {
    const active = isRuntimeActive();
    const cameToForeground = active && !wasRuntimeActive;
    wasRuntimeActive = active;
    if (!cameToForeground) return;
    const serverId = activeServerId();
    if ((demand.get(serverId) ?? 0) > 0) void load(serverId);
}

function totalDemand(): number {
    let total = 0;
    for (const count of demand.values()) total += count;
    return total;
}

/** Registers one mounted consumer (the session list); the first one reads. Returns the release. */
export function retainLeavingSessions(): () => void {
    const serverId = activeServerId();
    const count = demand.get(serverId) ?? 0;
    demand.set(serverId, count + 1);
    if (!stopForegroundListener) {
        wasRuntimeActive = isRuntimeActive();
        stopForegroundListener = subscribeToRuntimeActiveChange(handleRuntimeActiveChange);
    }
    if (count === 0) void load(serverId);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const remaining = (demand.get(serverId) ?? 1) - 1;
        if (remaining <= 0) demand.delete(serverId);
        else demand.set(serverId, remaining);
        if (totalDemand() === 0 && stopForegroundListener) {
            stopForegroundListener();
            stopForegroundListener = null;
        }
    };
}

/** Opening the Keep stack, or its Retry: one read. */
export function refreshLeavingSessions(): Promise<void> {
    return load(activeServerId());
}

export function getLeavingSessionsEntry(): LeavingSessionsEntry {
    const serverId = activeServerId();
    return entries.get(serverId) ?? idleEntry(serverId);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const releaseServer = subscribeActiveServer(listener);
    return () => {
        listeners.delete(listener);
        releaseServer();
    };
}

/** Retire account-owned notice data when a Home changes Accounts or credentials are removed. */
export function retireLeavingSessions(homeId?: string): void {
    const knownServerIds = new Set([...entries.keys(), ...inFlight.keys()]);
    let changed = false;
    for (const serverId of knownServerIds) {
        if (homeId !== undefined && !areServerProfileIdentifiersEquivalent(homeId, serverId)) continue;
        const running = inFlight.get(serverId);
        inFlight.delete(serverId);
        running?.controller.abort();
        changed = entries.delete(serverId) || changed;
    }
    if (changed) for (const listener of listeners) listener();
    if (homeId === undefined) return;
    const serverId = activeServerId();
    if (areServerProfileIdentifiersEquivalent(homeId, serverId) && (demand.get(serverId) ?? 0) > 0) {
        void load(serverId);
    }
}

/** Selects without adding demand: for leaves under a surface that already retains the read. */
export function useLeavingSessionsValue<T>(select: (entry: LeavingSessionsEntry) => T): T {
    const getSnapshot = React.useCallback(() => select(getLeavingSessionsEntry()), [select]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetLeavingSessionsResourceForTests(): void {
    retireLeavingSessions();
    idleEntries.clear();
    demand.clear();
    listeners.clear();
    stopForegroundListener?.();
    stopForegroundListener = null;
    wasRuntimeActive = true;
}
