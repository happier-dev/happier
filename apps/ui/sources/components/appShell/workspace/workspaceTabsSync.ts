import { WorkspaceTabsV1StoredSchema } from '@happier-dev/protocol/workspace/workspaceTabsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { applyWorkspaceTabIntents, emptyWorkspaceTabs, type SharedWorkspaceTabs, type WorkspaceTabIntent } from './workspaceSyncedTabs';
import { workspaceDestinationAdmissionIdentity } from './workspaceDestinationPolicy';
import type { DestinationRef } from '../destinations/compactAppDestinationCatalog';

export type WorkspaceTabsTransport = Readonly<{
    read: () => Promise<Readonly<{ value: unknown | null; version: number; tombstone?: true }>>;
    compareAndSet: (value: SharedWorkspaceTabs, version: number) => Promise<
        Readonly<{ success: true; version: number }> | Readonly<{ success: false; value: unknown | null; version: number; tombstone?: true }>
    >;
}>;
export class WorkspaceTabsSchemaError extends Error {
    readonly code = 'workspace_tabs_schema_invalid';
    constructor() { super('Stored workspace tabs are not a supported portable record'); }
}

export function parseWorkspaceTabs(value: unknown, version: number, tombstone = false): SharedWorkspaceTabs {
    if (value === null && (version === -1 || tombstone)) return emptyWorkspaceTabs();
    const result = WorkspaceTabsV1StoredSchema.safeParse(value);
    if (!result.success) throw new WorkspaceTabsSchemaError();
    return result.data;
}

export type WorkspaceTabsSyncSnapshot = Readonly<{ status: 'synced' | 'pending' | 'unavailable'; record: SharedWorkspaceTabs | null }>;

export function createWorkspaceTabsSync(input: Readonly<{
    transport: WorkspaceTabsTransport;
    onRecord: (record: SharedWorkspaceTabs, localRecord: SharedWorkspaceTabs) => void;
    getLocalRecord?: () => SharedWorkspaceTabs;
    shouldContinue?: () => boolean;
    onStatus?: (snapshot: WorkspaceTabsSyncSnapshot) => void;
    enroll?: () => readonly WorkspaceTabIntent[];
    normalizeRecord?: (record: SharedWorkspaceTabs) => SharedWorkspaceTabs;
    destinationIdentity?: (target: DestinationRef) => string;
}>) {
    let stopped = false;
    let record: SharedWorkspaceTabs | null = null;
    let version = -1;
    let pending: WorkspaceTabIntent[] = [];
    const tabAliases = new Map<string, Readonly<{ id: string; destinationKey: string }>>();
    let enrollmentCount = 0;
    let status: WorkspaceTabsSyncSnapshot['status'] = 'pending';
    let queue: Promise<void> = Promise.resolve();
    const current = () => !stopped && (input.shouldContinue?.() ?? true);
    const normalize = (value: SharedWorkspaceTabs) => input.normalizeRecord?.(value) ?? value;
    const destinationIdentity = input.destinationIdentity ?? workspaceDestinationAdmissionIdentity;
    const rememberNormalizedAliases = (before: SharedWorkspaceTabs, after: SharedWorkspaceTabs) => {
        // A currently retained identity is an alias root, including one restored by a peer.
        for (const id of after.order) tabAliases.delete(id);
        for (const id of before.order) {
            if (after.tabsById[id]) continue;
            const destinationKey = destinationIdentity(before.tabsById[id].target);
            const incumbent = after.order.find(kept => destinationIdentity(after.tabsById[kept].target) === destinationKey);
            if (incumbent) tabAliases.set(id, { id: incumbent, destinationKey });
        }
    };
    const normalizeWithAliases = (value: SharedWorkspaceTabs) => {
        const normalized = normalize(value);
        rememberNormalizedAliases(value, normalized);
        return normalized;
    };
    const resolvePendingId = (id: string): string => {
        const original = id;
        const destinationKey = tabAliases.get(id)?.destinationKey;
        while (tabAliases.has(id)) {
            const alias = tabAliases.get(id)!;
            if (alias.destinationKey !== destinationKey) return original;
            id = alias.id;
        }
        // A peer can close or retarget the winner; neither retires the original operation.
        const winner = record?.tabsById[id];
        return winner && (destinationKey === undefined || destinationIdentity(winner.target) === destinationKey) ? id : original;
    };
    const rebasePendingIntent = (intent: WorkspaceTabIntent): WorkspaceTabIntent => {
        if (intent.type === 'open') {
            const id = resolvePendingId(intent.tab.id);
            return id === intent.tab.id ? intent : { type: 'patch', tabId: id, target: intent.tab.target, pinned: intent.tab.pinned };
        }
        if (intent.type === 'pairs') return { ...intent, pairs: intent.pairs.map(pair => pair.map(resolvePendingId)) };
        if (intent.type === 'move') return { ...intent, tabId: resolvePendingId(intent.tabId), beforeId: intent.beforeId === null ? null : resolvePendingId(intent.beforeId) };
        return { ...intent, tabId: resolvePendingId(intent.tabId) };
    };
    const rememberLocalAliases = (local: SharedWorkspaceTabs | undefined) => {
        const shared = record;
        if (!local || !shared) return;
        // Catalog admission decides which retained local instances correspond to
        // shared singletons. Reuse that same normalization and alias owner without
        // enrolling local-only tabs or changing the canonical shared record.
        const combined: SharedWorkspaceTabs = { ...shared,
            tabsById: { ...local.tabsById, ...shared.tabsById },
            order: [...shared.order, ...local.order.filter(id => !shared.tabsById[id])],
        };
        rememberNormalizedAliases(combined, normalize(combined));
    };
    const localProjection = (value: SharedWorkspaceTabs, local: SharedWorkspaceTabs | undefined): SharedWorkspaceTabs => {
        if (!local) return value;
        const localIds = new Map<string, string>();
        for (const id of local.order) {
            const sharedId = resolvePendingId(id);
            if (sharedId !== id && value.tabsById[sharedId]
                && destinationIdentity(local.tabsById[id].target) === destinationIdentity(value.tabsById[sharedId].target)) {
                localIds.set(sharedId, id);
            }
        }
        if (!localIds.size) return value;
        const localId = (id: string) => localIds.get(id) ?? id;
        return { ...value, order: value.order.map(localId), pairs: value.pairs.map(pair => pair.map(localId)),
            tabsById: Object.fromEntries(value.order.map(id => [localId(id), { ...value.tabsById[id], id: localId(id) }])),
        };
    };
    const projected = () => record ? normalize(applyWorkspaceTabIntents(record,
        version === -1 && !pending.length ? input.enroll?.() ?? [] : pending.map(rebasePendingIntent))) : null;
    let cachedSnapshot: WorkspaceTabsSyncSnapshot = { status, record: null };
    let publishedSnapshot: WorkspaceTabsSyncSnapshot | null = null;
    let publishedRecord: SharedWorkspaceTabs | null = null;
    const snapshot = (): WorkspaceTabsSyncSnapshot => {
        const value = projected();
        const stableRecord = sameStrictJsonValue(value, cachedSnapshot.record) ? cachedSnapshot.record : value;
        if (status !== cachedSnapshot.status || stableRecord !== cachedSnapshot.record) {
            cachedSnapshot = { status, record: stableRecord };
        }
        return cachedSnapshot;
    };
    const notify = () => {
        if (!current()) return;
        const value = snapshot();
        if (value === publishedSnapshot) return;
        publishedSnapshot = value;
        input.onStatus?.(value);
    };
    const project = () => {
        if (!current()) return;
        if (record) record = normalizeWithAliases(record);
        const local = input.getLocalRecord?.();
        rememberLocalAliases(local);
        const value = snapshot().record;
        if (value && value !== publishedRecord) {
            publishedRecord = value;
            input.onRecord(value, localProjection(value, local));
        }
        notify();
    };
    const serialized = (run: () => Promise<void>) => {
        const operation = queue.then(async () => {
            if (!current()) return;
            try { await run(); } catch (error) { status = 'unavailable'; notify(); throw error; }
        });
        queue = operation.catch(() => {});
        return operation;
    };
    const read = async () => {
        const result = await input.transport.read();
        if (!current()) return;
        const parsed = normalizeWithAliases(parseWorkspaceTabs(result.value, result.version, result.tombstone));
        // A missing key preserves local restoration, but only accepted edits enroll it.
        // Existing records never reseed remotely closed saved tabs.
        if (record === null && result.version === -1 && pending.length) {
            const enrollment = input.enroll?.() ?? [];
            enrollmentCount = enrollment.length;
            pending = [...enrollment, ...pending];
        }
        record = parsed; version = result.version;
        status = pending.length ? 'pending' : 'synced';
        project();
    };
    return {
        reproject: project,
        reconcileLocal: () => {
            if (!current()) return;
            const local = input.getLocalRecord?.();
            rememberLocalAliases(local);
            const value = snapshot().record;
            if (value) input.onRecord(value, localProjection(value, local));
        },
        refresh: () => {
            // Catalog policy changes apply to the cached projection even if the reread fails.
            project();
            return serialized(read);
        },
        flush: () => serialized(async () => {
            if (record === null) await read();
            while (current() && record && pending.length) {
                const count = pending.length;
                const replayed = applyWorkspaceTabIntents(record, pending.slice(0, count).map(rebasePendingIntent));
                const proposed = normalizeWithAliases(replayed);
                // A CAS singleton merge can retire an ID while the user is still editing it.
                // Retained local instances also use these validated aliases after
                // drain; nothing is persisted beyond this Account/window runtime.
                if (proposed === record) { pending = pending.slice(count); enrollmentCount = 0; continue; }
                const result = await input.transport.compareAndSet(proposed, version);
                if (!current()) return;
                if (result.success) { record = proposed; version = result.version; pending = pending.slice(count); enrollmentCount = 0; }
                else {
                    record = normalizeWithAliases(parseWorkspaceTabs(result.value, result.version, result.tombstone)); version = result.version;
                    // A hidden tombstone is not first enrollment: keep explicit new edits only.
                    if (result.tombstone && enrollmentCount) { pending = pending.slice(enrollmentCount); enrollmentCount = 0; }
                }
                project();
            }
            status = pending.length ? 'pending' : 'synced';
            if (!pending.length) {
                tabAliases.clear();
                rememberLocalAliases(input.getLocalRecord?.());
            }
            notify();
        }),
        enqueue: (intents: readonly WorkspaceTabIntent[]) => {
            if (!current() || !intents.length) return;
            if (record && version === -1 && !pending.length) {
                const enrollment = input.enroll?.() ?? [];
                enrollmentCount = enrollment.length;
                pending.push(...enrollment);
            }
            pending.push(...intents); status = 'pending'; notify();
        },
        stop: () => { stopped = true; pending = []; tabAliases.clear(); },
        getSnapshot: snapshot,
    };
}
