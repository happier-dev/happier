import {
    SubagentRefInputV1Schema,
    SubagentRefV1Schema,
    type SubagentLifecycleDetailV1,
    type SubagentRefInputV1,
    type SubagentRefV1,
    type SubagentStatusV1,
} from '@happier-dev/protocol';

export type HostSubagentActor =
    | Readonly<{ kind: 'host' }>
    | Readonly<{ kind: 'externalRpc' }>
    | Readonly<{ kind: 'plugin'; pluginId: string; agentId: string }>;

export class HostSubagentStoreError extends Error {
    constructor(
        readonly code:
            | 'subagent_write_forbidden'
            | 'subagent_not_found'
            | 'subagent_parent_session_required'
            | 'subagent_capacity_exceeded'
            | 'subagent_watch_capacity_exceeded'
            | 'subagent_session_scope_forbidden',
        message = code,
    ) {
        super(message);
        this.name = 'HostSubagentStoreError';
    }
}

export type HostSubagentStoreOptions = Readonly<{
    maxListResults?: number;
    maxWatchers?: number;
    watchIdleTtlMs?: number;
    maxSubagentsPerParent?: number;
}>;

const DEFAULT_MAX_LIST_RESULTS = 256;
const DEFAULT_MAX_WATCHERS = 32;
const DEFAULT_WATCH_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SUBAGENTS_PER_PARENT = 256;

export type HostSubagentListParams = Readonly<{
    parentSessionId?: string;
    groupId?: string | null;
    limit?: number;
}>;

export type HostSubagentGetParams = Readonly<{
    id: string;
    parentSessionId?: string;
}>;

export type HostSubagentWatchParams = Readonly<{
    parentSessionId?: string;
    id?: string;
}>;

export type HostSubagentWatchOptions = Readonly<{
    onClose?: () => void;
}>;

export type HostSubagentWatchEvent = Readonly<{
    kind: 'snapshot' | 'changed' | 'removed';
    subagents?: readonly SubagentRefV1[];
    subagent?: SubagentRefV1;
    id?: string;
}>;

export type HostSubagentStore = Readonly<{
    list(params?: HostSubagentListParams): Promise<readonly SubagentRefV1[]>;
    get(params: HostSubagentGetParams): Promise<SubagentRefV1 | null>;
    watch(
        params: HostSubagentWatchParams,
        onEvent: (event: HostSubagentWatchEvent) => void,
        options?: HostSubagentWatchOptions,
    ): Readonly<{ unsubscribe(): void }>;
    upsert(params: Readonly<{ actor: HostSubagentActor; input: SubagentRefInputV1 }>): Promise<SubagentRefV1>;
    updateStatus(params: Readonly<{
        actor: HostSubagentActor;
        id: string;
        parentSessionId?: string;
        status: SubagentStatusV1;
        lifecycleDetail?: SubagentLifecycleDetailV1;
        completedAt?: number;
    }>): Promise<SubagentRefV1>;
    complete(params: Readonly<{
        actor: HostSubagentActor;
        id: string;
        parentSessionId?: string;
        status?: Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
        lifecycleDetail?: SubagentLifecycleDetailV1;
        completedAt?: number;
    }>): Promise<SubagentRefV1>;
}>;

type Watcher = {
    params: HostSubagentWatchParams;
    onEvent: (event: HostSubagentWatchEvent) => void;
    onClose: (() => void) | null;
    idleTimer: ReturnType<typeof setTimeout> | null;
};

type SubagentOwner = Readonly<
    | { kind: 'host' }
    | { kind: 'plugin'; pluginId: string }
>;

function normalizeOptionalString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function subagentKey(ref: Readonly<{ parentSessionId: string; id: string }>): string {
    return `${ref.parentSessionId}\u0000${ref.id}`;
}

function cloneRef(ref: SubagentRefV1): SubagentRefV1 {
    return Object.freeze(SubagentRefV1Schema.parse(ref));
}

function isPluginOwner(actor: HostSubagentActor, ref: SubagentRefInputV1 | SubagentRefV1): boolean {
    if (actor.kind === 'host') return true;
    if (actor.kind !== 'plugin') return false;
    if (ref.origin === 'plugin') {
        const agentId = normalizeOptionalString(ref.agentRef?.agentId);
        return agentId === null || agentId === actor.agentId;
    }
    if (ref.origin === 'agent') {
        return normalizeOptionalString(ref.agentRef?.agentId) === actor.agentId;
    }
    return false;
}

function assertCanWrite(actor: HostSubagentActor, ref: SubagentRefInputV1 | SubagentRefV1): void {
    if (!isPluginOwner(actor, ref)) {
        throw new HostSubagentStoreError('subagent_write_forbidden');
    }
}

function matchesFilters(ref: SubagentRefV1, params?: HostSubagentListParams | HostSubagentWatchParams): boolean {
    if (!params) return true;
    const parentSessionId = normalizeOptionalString(params.parentSessionId);
    if (parentSessionId && ref.parentSessionId !== parentSessionId) return false;
    if ('id' in params) {
        const id = normalizeOptionalString(params.id);
        if (id && ref.id !== id) return false;
    }
    if ('groupId' in params && params.groupId !== undefined) {
        const groupId = normalizeOptionalString(params.groupId);
        if (groupId && ref.groupRef?.groupId !== groupId) return false;
        if (params.groupId === null && ref.groupRef?.groupId) return false;
    }
    return true;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}

function countRefsForParent(refsByKey: ReadonlyMap<string, SubagentRefV1>, parentSessionId: string): number {
    let count = 0;
    for (const ref of refsByKey.values()) {
        if (ref.parentSessionId === parentSessionId) {
            count += 1;
        }
    }
    return count;
}

function requireParentSessionId(parentSessionId: string | null): string {
    if (!parentSessionId) {
        throw new HostSubagentStoreError('subagent_parent_session_required');
    }
    return parentSessionId;
}

export function createHostSubagentStore(options: HostSubagentStoreOptions = {}): HostSubagentStore {
    const maxListResults = normalizePositiveInteger(options.maxListResults, DEFAULT_MAX_LIST_RESULTS);
    const maxWatchers = normalizePositiveInteger(options.maxWatchers, DEFAULT_MAX_WATCHERS);
    const watchIdleTtlMs = normalizePositiveInteger(options.watchIdleTtlMs, DEFAULT_WATCH_IDLE_TTL_MS);
    const maxSubagentsPerParent = normalizePositiveInteger(options.maxSubagentsPerParent, DEFAULT_MAX_SUBAGENTS_PER_PARENT);
    const refsByKey = new Map<string, SubagentRefV1>();
    const ownersByKey = new Map<string, SubagentOwner>();
    const watchers = new Set<Watcher>();
    const pendingChangedByKey = new Map<string, SubagentRefV1>();
    let changeFlushScheduled = false;

    const list = async (params?: HostSubagentListParams): Promise<readonly SubagentRefV1[]> => (
        Object.freeze([...refsByKey.values()]
            .filter((ref) => matchesFilters(ref, params))
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
            .slice(0, Math.min(maxListResults, normalizePositiveInteger(params?.limit, maxListResults)))
            .map(cloneRef))
    );

    const deleteWatcher = (watcher: Watcher): void => {
        if (!watchers.delete(watcher)) {
            return;
        }
        if (watcher.idleTimer) {
            clearTimeout(watcher.idleTimer);
            watcher.idleTimer = null;
        }
        watcher.onClose?.();
    };

    const refreshWatcherIdleTimer = (watcher: Watcher): void => {
        if (watcher.idleTimer) {
            clearTimeout(watcher.idleTimer);
        }
        watcher.idleTimer = setTimeout(() => {
            deleteWatcher(watcher);
        }, watchIdleTtlMs);
        watcher.idleTimer.unref?.();
    };

    const flushChangedNotifications = (): void => {
        changeFlushScheduled = false;
        const changedRefs = [...pendingChangedByKey.values()];
        pendingChangedByKey.clear();
        for (const watcher of watchers) {
            for (const ref of changedRefs) {
                if (matchesFilters(ref, watcher.params)) {
                    refreshWatcherIdleTimer(watcher);
                    watcher.onEvent(Object.freeze({ kind: 'changed', subagent: cloneRef(ref) }));
                }
            }
        }
    };

    const notifyChanged = (ref: SubagentRefV1): void => {
        pendingChangedByKey.set(subagentKey(ref), ref);
        if (changeFlushScheduled) {
            return;
        }
        changeFlushScheduled = true;
        queueMicrotask(flushChangedNotifications);
    };

    const getExisting = (params: HostSubagentGetParams): SubagentRefV1 => {
        const parentSessionId = normalizeOptionalString(params.parentSessionId);
        const ref = parentSessionId
            ? refsByKey.get(subagentKey({ parentSessionId, id: params.id }))
            : [...refsByKey.values()].find((candidate) => candidate.id === params.id);
        if (!ref) {
            throw new HostSubagentStoreError('subagent_not_found');
        }
        return ref;
    };

    const assertCanMutateExisting = (actor: HostSubagentActor, key: string): void => {
        if (actor.kind === 'host') {
            return;
        }
        const owner = ownersByKey.get(key);
        if (actor.kind !== 'plugin' || owner?.kind !== 'plugin' || owner.pluginId !== actor.pluginId) {
            throw new HostSubagentStoreError('subagent_write_forbidden');
        }
    };

    return Object.freeze({
        list,
        async get(params) {
            const parentSessionId = normalizeOptionalString(params.parentSessionId);
            const ref = parentSessionId
                ? refsByKey.get(subagentKey({ parentSessionId, id: params.id }))
                : [...refsByKey.values()].find((candidate) => candidate.id === params.id);
            return ref ? cloneRef(ref) : null;
        },
        watch(params, onEvent, watchOptions) {
            if (watchers.size >= maxWatchers) {
                throw new HostSubagentStoreError('subagent_watch_capacity_exceeded');
            }
            const watcher: Watcher = {
                params,
                onEvent,
                onClose: watchOptions?.onClose ?? null,
                idleTimer: null,
            };
            watchers.add(watcher);
            refreshWatcherIdleTimer(watcher);
            void list(params).then((subagents) => {
                if (watchers.has(watcher)) {
                    refreshWatcherIdleTimer(watcher);
                    onEvent(Object.freeze({ kind: 'snapshot', subagents }));
                }
            });
            return Object.freeze({
                unsubscribe() {
                    deleteWatcher(watcher);
                },
            });
        },
        async upsert(params) {
            const parsed = SubagentRefInputV1Schema.parse(params.input);
            assertCanWrite(params.actor, parsed);
            const now = Date.now();
            const key = subagentKey(parsed);
            const existing = refsByKey.get(key);
            if (existing) {
                assertCanMutateExisting(params.actor, key);
            }
            if (!existing && countRefsForParent(refsByKey, parsed.parentSessionId) >= maxSubagentsPerParent) {
                throw new HostSubagentStoreError('subagent_capacity_exceeded');
            }
            const next = cloneRef({
                ...existing,
                ...parsed,
                status: parsed.status ?? existing?.status ?? 'pending',
                createdAt: parsed.createdAt ?? existing?.createdAt ?? now,
            });
            refsByKey.set(key, next);
            if (!existing) {
                ownersByKey.set(key, params.actor.kind === 'plugin'
                    ? Object.freeze({ kind: 'plugin', pluginId: params.actor.pluginId })
                    : Object.freeze({ kind: 'host' }));
            }
            notifyChanged(next);
            return cloneRef(next);
        },
        async updateStatus(params) {
            const parentSessionId = requireParentSessionId(normalizeOptionalString(params.parentSessionId));
            const existing = getExisting({ id: params.id, parentSessionId });
            assertCanMutateExisting(params.actor, subagentKey(existing));
            const next = cloneRef({
                ...existing,
                status: params.status,
                ...(params.lifecycleDetail ? { lifecycleDetail: params.lifecycleDetail } : {}),
                ...(typeof params.completedAt === 'number' ? { completedAt: params.completedAt } : {}),
            });
            refsByKey.set(subagentKey(next), next);
            notifyChanged(next);
            return cloneRef(next);
        },
        async complete(params) {
            const parentSessionId = requireParentSessionId(normalizeOptionalString(params.parentSessionId));
            const existing = getExisting({ id: params.id, parentSessionId });
            assertCanMutateExisting(params.actor, subagentKey(existing));
            const next = cloneRef({
                ...existing,
                status: params.status ?? 'completed',
                ...(params.lifecycleDetail ? { lifecycleDetail: params.lifecycleDetail } : {}),
                completedAt: params.completedAt ?? Date.now(),
            });
            refsByKey.set(subagentKey(next), next);
            notifyChanged(next);
            return cloneRef(next);
        },
    });
}

export const hostSubagentStore = createHostSubagentStore();
