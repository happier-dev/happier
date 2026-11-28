import * as React from 'react';

import type { AccountPlanResponseV1 } from '@happier-dev/protocol';

import { log } from '@/log';
import { fetchAccountPlan } from '@/sync/api/account/apiAccountPlan';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';

/**
 * The one loader of `GET /v1/account/plan` (plan 01, consumed by plan 04).
 *
 * Demand-driven: it reads when the first consumer mounts and again on a plan change hint or a
 * Check again while one is mounted. No boot read, no polling, no focus re-read. Last-known data is
 * kept per server, so reopening the page shows it at once while the fresh read runs, and a failed
 * read keeps it with an error status: a surface must never fall back to "Free" after a failure.
 */

export type AccountPlanStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

export type AccountPlanEntry = Readonly<{
    data: AccountPlanResponseV1 | null;
    status: AccountPlanStatus;
    /** Epoch ms of the last successful read, for the freshness line. */
    readAtMs: number | null;
}>;

const IDLE_ENTRY: AccountPlanEntry = Object.freeze({ data: null, status: 'idle', readAtMs: null });

const entries = new Map<string, AccountPlanEntry>();
const demand = new Map<string, number>();
const inFlight = new Map<string, { controller: AbortController; promise: Promise<void> }>();
/** A hint that arrived while a read was in flight: the in-flight body may predate the change. */
const rereadAfterFlight = new Set<string>();
const listeners = new Set<() => void>();

function activeServerId(): string {
    return getActiveServerSnapshot().serverId;
}

function publish(serverId: string, next: AccountPlanEntry): void {
    const previous = entries.get(serverId) ?? IDLE_ENTRY;
    if (previous.data === next.data && previous.status === next.status && previous.readAtMs === next.readAtMs) return;
    entries.set(serverId, next);
    for (const listener of listeners) listener();
}

/** The response is plain JSON parsed through one schema, so field order is stable. */
function samePlan(left: AccountPlanResponseV1 | null, right: AccountPlanResponseV1): boolean {
    return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function load(serverId: string): Promise<void> {
    const running = inFlight.get(serverId);
    if (running) {
        rereadAfterFlight.add(serverId);
        return running.promise;
    }
    const current = entries.get(serverId) ?? IDLE_ENTRY;
    if (current.data === null && current.status !== 'loading') publish(serverId, { ...current, status: 'loading' });
    const controller = new AbortController();
    const promise = (async () => {
        try {
            const result = await fetchAccountPlan(controller.signal);
            if (controller.signal.aborted || activeServerId() !== serverId) return;
            const previous = entries.get(serverId) ?? IDLE_ENTRY;
            if (result.kind === 'unavailable') {
                publish(serverId, { data: null, status: 'unavailable', readAtMs: Date.now() });
                return;
            }
            const data = samePlan(previous.data, result.plan) ? previous.data : result.plan;
            publish(serverId, { data, status: 'ready', readAtMs: Date.now() });
        } catch (error) {
            if (controller.signal.aborted || activeServerId() !== serverId) return;
            const previous = entries.get(serverId) ?? IDLE_ENTRY;
            publish(serverId, { ...previous, status: 'error' });
            log.log(`[plans] account plan read failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (inFlight.get(serverId)?.controller === controller) {
                inFlight.delete(serverId);
                if (rereadAfterFlight.delete(serverId) && activeServerId() === serverId && (demand.get(serverId) ?? 0) > 0) void load(serverId);
            }
        }
    })();
    inFlight.set(serverId, { controller, promise });
    return promise;
}

/** Registers one mounted consumer; the first one reads. Returns the release function. */
export function retainAccountPlan(): () => void {
    const serverId = activeServerId();
    const count = demand.get(serverId) ?? 0;
    demand.set(serverId, count + 1);
    if (count === 0) void load(serverId);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const remaining = (demand.get(serverId) ?? 1) - 1;
        if (remaining <= 0) demand.delete(serverId);
        else demand.set(serverId, remaining);
    };
}

/** A plan change hint (push or change cursor): re-read only while someone is looking. */
export function invalidateAccountPlan(): void {
    const serverId = activeServerId();
    if ((demand.get(serverId) ?? 0) > 0) void load(serverId);
}

/** Check again / Retry: the read-your-own-write path. */
export function refreshAccountPlan(): Promise<void> {
    return load(activeServerId());
}

export function getAccountPlanEntry(): AccountPlanEntry {
    return entries.get(activeServerId()) ?? IDLE_ENTRY;
}

/** Drops account-owned data when a Home changes Accounts or all credentials are removed. */
export function retireAccountPlan(homeId?: string): void {
    const serverIds = new Set([...entries.keys(), ...inFlight.keys()]);
    let changed = false;
    for (const serverId of serverIds) {
        if (homeId !== undefined && !areServerProfileIdentifiersEquivalent(homeId, serverId)) continue;
        const running = inFlight.get(serverId);
        inFlight.delete(serverId);
        rereadAfterFlight.delete(serverId);
        running?.controller.abort();
        changed = entries.delete(serverId) || changed;
    }
    if (changed) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const releaseServer = subscribeActiveServer(listener);
    return () => {
        listeners.delete(listener);
        releaseServer();
    };
}

/**
 * Mounts demand for the plan read and selects one fact of it. A selector keeps a consumer of one
 * fact from re-rendering on another; it must return a stable value for equal input.
 */
export function useAccountPlan<T>(select: (entry: AccountPlanEntry) => T): T {
    const serverId = React.useSyncExternalStore(subscribeActiveServer, activeServerId, activeServerId);
    React.useEffect(() => retainAccountPlan(), [serverId]);
    const getSnapshot = React.useCallback(() => select(getAccountPlanEntry()), [select]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Selects without adding demand: for leaves under a surface that already retains the read. */
export function useAccountPlanValue<T>(select: (entry: AccountPlanEntry) => T): T {
    const getSnapshot = React.useCallback(() => select(getAccountPlanEntry()), [select]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetAccountPlanResourceForTests(): void {
    retireAccountPlan();
    demand.clear();
    listeners.clear();
}
