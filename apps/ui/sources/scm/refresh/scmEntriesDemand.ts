import { summarizeScmChanges } from '@happier-dev/protocol/scm';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

/**
 * Which snapshot slots have a presented list consumer (Git/Review pane, file lists, Changes glance).
 * Delivery follows consumption: a snapshot refresh ships the changed-file list only while its slot
 * is demanded here, otherwise the shared counts (`detail: 'summary'`). Demand lasts while a consumer
 * is presented, never retained history. A hidden retained consumer keeps the rows it has and reads
 * nothing; it revalidates on show only if the slot's counts moved meanwhile. A slot is a workspace scope, or a legacy unscoped Session.
 */
export type ScmEntriesDemandSlot =
    | Readonly<{ kind: 'workspace'; scope: WorkspaceScopeBase }>
    | Readonly<{ kind: 'session'; sessionId: string }>;

const countsBySnapshot = new WeakMap<ScmWorkingSnapshot, ScmWorkingSnapshot>();

/**
 * A snapshot as its counts readers and a released slot see it: the shared counts without the rows, so
 * holding it never holds the list. One view per snapshot, so an unchanged snapshot keeps its identity.
 */
export function readScmSnapshotCounts(snapshot: ScmWorkingSnapshot): ScmWorkingSnapshot {
    if (snapshot.detail) return snapshot;
    let counts = countsBySnapshot.get(snapshot);
    if (!counts) {
        const { entriesPage: _entriesPage, ...facts } = snapshot;
        counts = { ...facts, entries: [], detail: 'summary', summary: snapshot.summary ?? summarizeScmChanges(snapshot.entries, snapshot.totals) };
        countsBySnapshot.set(snapshot, counts);
    }
    return counts;
}

const demandBySlotKey = new Map<string, Map<number | undefined, number>>();
const holdBySlotKey = new Map<string, number>();
const admissionListeners = new Set<(slot: ScmEntriesDemandSlot) => void>();
const releaseListeners = new Set<(slot: ScmEntriesDemandSlot) => void>();

function slotKey(slot: ScmEntriesDemandSlot | null | undefined): string | null {
    if (!slot) return null;
    if (slot.kind === 'session') return slot.sessionId ? `session:${slot.sessionId}` : null;
    const key = tryBuildWorkspaceCacheKey(slot.scope);
    return key ? `workspace:${key}` : null;
}

function largestEntriesPageSize(demands: ReadonlyMap<number | undefined, number>): number | undefined {
    if (demands.has(undefined)) return undefined;
    let largest = 0;
    for (const size of demands.keys()) if (size !== undefined && size > largest) largest = size;
    return largest || undefined;
}

/** Full consumers override viewport consumers; otherwise delivery covers the largest viewport.
 * Undefined means full or no demand; `hasScmEntriesDemand` distinguishes those cases.
 */
export function readScmEntriesPageSize(slot: ScmEntriesDemandSlot | null | undefined): number | undefined {
    const key = slotKey(slot);
    const demands = key === null ? undefined : demandBySlotKey.get(key);
    return demands ? largestEntriesPageSize(demands) : undefined;
}

export function retainScmEntriesDemand(slot: ScmEntriesDemandSlot, entriesPageSize?: number): () => void {
    const key = slotKey(slot);
    if (!key) return () => {};
    const previous = demandBySlotKey.get(key);
    const previousSize = previous ? largestEntriesPageSize(previous) : undefined;
    const demands = previous ?? new Map<number | undefined, number>();
    demands.set(entriesPageSize, (demands.get(entriesPageSize) ?? 0) + 1);
    demandBySlotKey.set(key, demands);
    if (!previous || previousSize !== largestEntriesPageSize(demands)) {
        for (const listener of admissionListeners) listener(slot);
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const previousSize = largestEntriesPageSize(demands);
        const count = (demands.get(entriesPageSize) ?? 1) - 1;
        if (count > 0) demands.set(entriesPageSize, count);
        else demands.delete(entriesPageSize);
        if (demands.size > 0) {
            if (previousSize !== largestEntriesPageSize(demands)) {
                for (const listener of admissionListeners) listener(slot);
            }
            return;
        }
        demandBySlotKey.delete(key);
        queueMicrotask(() => notifyScmEntriesUnheld(slot));
    };
}

/**
 * A mounted list consumer keeps the slot's rows, presented or hidden; only its close lets them go.
 * Holding reads nothing: `hasScmEntriesDemand` alone decides whether a refresh carries the list.
 */
export function retainScmEntriesHold(slot: ScmEntriesDemandSlot): () => void {
    const key = slotKey(slot);
    if (!key) return () => {};
    holdBySlotKey.set(key, (holdBySlotKey.get(key) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = (holdBySlotKey.get(key) ?? 1) - 1;
        if (count > 0) {
            holdBySlotKey.set(key, count);
            return;
        }
        holdBySlotKey.delete(key);
        // A commit that hands the slot from one consumer to the next releases and retains in one tick.
        queueMicrotask(() => notifyScmEntriesUnheld(slot));
    };
}

/** A list delivered to, or left in, a slot no consumer holds is released by the snapshot owner. */
export function notifyScmEntriesUnheld(slot: ScmEntriesDemandSlot): void {
    const key = slotKey(slot);
    if (key === null || demandBySlotKey.has(key) || holdBySlotKey.has(key)) return;
    for (const listener of releaseListeners) listener(slot);
}

export function hasScmEntriesDemand(slot: ScmEntriesDemandSlot | null | undefined): boolean {
    if (demandBySlotKey.size === 0) return false;
    const key = slotKey(slot);
    return key !== null && demandBySlotKey.has(key);
}

export function isSameScmEntriesDemandSlot(left: ScmEntriesDemandSlot, right: ScmEntriesDemandSlot): boolean {
    const key = slotKey(left);
    return key !== null && key === slotKey(right);
}

/** The snapshot owner listens for a slot's last list consumer closing; returns the unsubscribe. */
export function subscribeScmEntriesDemandReleases(listener: (slot: ScmEntriesDemandSlot) => void): () => void {
    releaseListeners.add(listener);
    return () => { releaseListeners.delete(listener); };
}

/** The snapshot owner listens for a slot's effective delivery demand changing; returns the unsubscribe. */
export function subscribeScmEntriesDemandAdmissions(listener: (slot: ScmEntriesDemandSlot) => void): () => void {
    admissionListeners.add(listener);
    return () => { admissionListeners.delete(listener); };
}
