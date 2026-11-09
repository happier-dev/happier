import type { WorkspaceSyncConflictListV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { listWorkspaceSyncConflicts } from '@/sync/ops/workspaceSync';
import type { WorkspaceSyncStatusScope } from './workspaceSyncStatusStore';

export type WorkspaceSyncConflictSnapshot = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing' | 'loading_more' | 'ready' | 'invalidated' | 'error';
    list: WorkspaceSyncConflictListV1 | null;
    nextCursor: string | null;
    hasMore: boolean;
    invalidated: boolean;
    error: unknown | null;
}>;

type Entry = {
    scope: WorkspaceSyncStatusScope;
    snapshot: WorkspaceSyncConflictSnapshot;
    listeners: Set<() => void>;
    inFlight: Promise<WorkspaceSyncConflictListV1> | null;
    admissionGeneration: number;
    controller: AbortController | null;
};

const entries = new Map<string, Entry>();
const IDLE_SNAPSHOT: WorkspaceSyncConflictSnapshot = {
    phase: 'idle', list: null, nextCursor: null, hasMore: false, invalidated: false, error: null,
};

function keyFor(scope: WorkspaceSyncStatusScope): string {
    return JSON.stringify([scope.serverId ?? null, scope.controllerMachineId, scope.relationshipId]);
}

function entryFor(scope: WorkspaceSyncStatusScope): Entry {
    const key = keyFor(scope);
    const current = entries.get(key);
    if (current) return current;
    const created: Entry = { scope, snapshot: IDLE_SNAPSHOT, listeners: new Set(), inFlight: null, admissionGeneration: 0, controller: null };
    entries.set(key, created);
    return created;
}

function publish(entry: Entry, snapshot: WorkspaceSyncConflictSnapshot): void {
    const previous = entry.snapshot;
    const previousList = previous.list;
    let list = snapshot.list;
    if (previousList && list && previousList !== list) {
        const previousByPath = new Map(previousList.conflicts.map(conflict => [conflict.path, conflict]));
        const conflicts = list.conflicts.map(conflict => {
            const retained = previousByPath.get(conflict.path);
            return retained && sameStrictJsonValue(retained, conflict) ? retained : conflict;
        });
        const retainedConflicts = conflicts.length === previousList.conflicts.length
            && conflicts.every((conflict, index) => conflict === previousList.conflicts[index])
            ? previousList.conflicts : conflicts;
        list = { ...list, conflicts: retainedConflicts };
        if (sameStrictJsonValue(previousList, list)) list = previousList;
    }
    if (previous.phase === snapshot.phase && previous.list === list
        && previous.nextCursor === snapshot.nextCursor && previous.hasMore === snapshot.hasMore
        && previous.invalidated === snapshot.invalidated && previous.error === snapshot.error) return;
    if (snapshot.list !== list) snapshot = { ...snapshot, list };
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
}

export function getWorkspaceSyncConflictSnapshot(scope: WorkspaceSyncStatusScope): WorkspaceSyncConflictSnapshot {
    return entryFor(scope).snapshot;
}

export function subscribeWorkspaceSyncConflicts(scope: WorkspaceSyncStatusScope, listener: () => void): () => void {
    const entry = entryFor(scope);
    entry.listeners.add(listener);
    return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0 || !entry.inFlight) return;
        entry.admissionGeneration += 1;
        entry.controller?.abort();
        entry.controller = null;
        entry.inFlight = null;
        publish(entry, { ...entry.snapshot, phase: 'idle', error: null });
    };
}

export function invalidateWorkspaceSyncConflicts(scope: WorkspaceSyncStatusScope): void {
    const entry = entryFor(scope);
    entry.admissionGeneration += 1;
    if (entry.inFlight) {
        entry.controller?.abort();
        entry.controller = null;
        entry.inFlight = null;
    }
    if (entry.listeners.size > 0) {
        void refreshWorkspaceSyncConflicts(scope).catch(() => undefined);
        return;
    }
    publish(entry, { ...entry.snapshot, phase: 'idle', error: null });
}

export function invalidateWorkspaceSyncControllerConflicts(controller: Readonly<{
    serverId: string | null;
    controllerMachineId: string;
}>): void {
    for (const entry of entries.values()) {
        if ((entry.scope.serverId ?? null) !== controller.serverId
            || entry.scope.controllerMachineId !== controller.controllerMachineId) continue;
        invalidateWorkspaceSyncConflicts(entry.scope);
    }
}

function aggregatePage(
    previous: WorkspaceSyncConflictListV1 | null,
    page: Extract<Awaited<ReturnType<typeof listWorkspaceSyncConflicts>>, { status: 'page' }>,
): WorkspaceSyncConflictListV1 {
    const conflicts = previous ? [...previous.conflicts, ...page.conflicts] : [...page.conflicts];
    return {
        relationshipId: page.relationshipId,
        totalCount: page.totalCount,
        shownCount: conflicts.length,
        truncatedCount: Math.max(0, page.totalCount - conflicts.length),
        conflicts,
    };
}

function applyPage(
    entry: Entry,
    page: Awaited<ReturnType<typeof listWorkspaceSyncConflicts>>,
    previous: WorkspaceSyncConflictListV1 | null,
    admissionGeneration: number,
): WorkspaceSyncConflictListV1 {
    if (entry.admissionGeneration !== admissionGeneration) {
        return entry.snapshot.list ?? previous ?? {
            relationshipId: page.relationshipId, totalCount: 0, shownCount: 0, truncatedCount: 0, conflicts: [],
        };
    }
    if (page.status === 'cursor_invalidated') {
        const list = previous ?? {
            relationshipId: page.relationshipId, totalCount: 0, shownCount: 0, truncatedCount: 0, conflicts: [],
        };
        publish(entry, {
            phase: 'invalidated', list, nextCursor: null, hasMore: false, invalidated: true, error: null,
        });
        return list;
    }
    const list = aggregatePage(previous, page);
    publish(entry, {
        phase: 'ready', list, nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null, invalidated: false, error: null,
    });
    return entry.snapshot.list ?? list;
}

export function refreshWorkspaceSyncConflicts(scope: WorkspaceSyncStatusScope): Promise<WorkspaceSyncConflictListV1> {
    const entry = entryFor(scope);
    if (entry.inFlight) return entry.inFlight;
    publish(entry, {
        phase: entry.snapshot.list ? 'refreshing' : 'loading',
        list: entry.snapshot.list,
        nextCursor: entry.snapshot.nextCursor,
        hasMore: entry.snapshot.hasMore,
        invalidated: false,
        error: null,
    });
    const admissionGeneration = entry.admissionGeneration;
    const controller = new AbortController();
    entry.controller = controller;
    let inFlight!: Promise<WorkspaceSyncConflictListV1>;
    inFlight = listWorkspaceSyncConflicts({ ...scope, signal: controller.signal }).then(
        (page) => applyPage(entry, page, null, admissionGeneration),
        (error: unknown) => {
            if (!controller.signal.aborted && entry.admissionGeneration === admissionGeneration) {
                publish(entry, { ...entry.snapshot, phase: 'error', error });
            }
            throw error;
        },
    ).finally(() => {
        if (entry.inFlight === inFlight) { entry.inFlight = null; entry.controller = null; }
        if (!controller.signal.aborted && entry.admissionGeneration !== admissionGeneration && entry.listeners.size > 0) {
            void refreshWorkspaceSyncConflicts(scope).catch(() => undefined);
        }
    });
    entry.inFlight = inFlight;
    return inFlight;
}

export function loadMoreWorkspaceSyncConflicts(scope: WorkspaceSyncStatusScope): Promise<WorkspaceSyncConflictListV1> {
    const entry = entryFor(scope);
    if (entry.inFlight) return entry.inFlight;
    const cursor = entry.snapshot.nextCursor;
    if (!cursor || !entry.snapshot.list) {
        return Promise.resolve(entry.snapshot.list ?? {
            relationshipId: scope.relationshipId, totalCount: 0, shownCount: 0, truncatedCount: 0, conflicts: [],
        });
    }
    const previous = entry.snapshot.list;
    publish(entry, { ...entry.snapshot, phase: 'loading_more', error: null });
    const admissionGeneration = entry.admissionGeneration;
    const controller = new AbortController();
    entry.controller = controller;
    let inFlight!: Promise<WorkspaceSyncConflictListV1>;
    inFlight = listWorkspaceSyncConflicts({ ...scope, cursor, signal: controller.signal }).then(
        (page) => applyPage(entry, page, previous, admissionGeneration),
        (error: unknown) => {
            if (!controller.signal.aborted && entry.admissionGeneration === admissionGeneration) {
                publish(entry, { ...entry.snapshot, phase: 'error', error });
            }
            throw error;
        },
    ).finally(() => {
        if (entry.inFlight === inFlight) { entry.inFlight = null; entry.controller = null; }
        if (!controller.signal.aborted && entry.admissionGeneration !== admissionGeneration && entry.listeners.size > 0) {
            void refreshWorkspaceSyncConflicts(scope).catch(() => undefined);
        }
    });
    entry.inFlight = inFlight;
    return inFlight;
}

export function resetWorkspaceSyncConflictStoreForTests(): void {
    for (const entry of entries.values()) entry.controller?.abort();
    entries.clear();
}
