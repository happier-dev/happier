import { WorkspaceTabsV1StoredSchema } from '@happier-dev/protocol';
import { applyWorkspaceTabIntents, emptyWorkspaceTabs, type SharedWorkspaceTabs, type WorkspaceTabIntent } from './workspaceSyncedTabs';

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
    onRecord: (record: SharedWorkspaceTabs) => void;
    shouldContinue?: () => boolean;
    onStatus?: (snapshot: WorkspaceTabsSyncSnapshot) => void;
    enroll?: () => readonly WorkspaceTabIntent[];
    normalizeRecord?: (record: SharedWorkspaceTabs) => SharedWorkspaceTabs;
}>) {
    let stopped = false;
    let record: SharedWorkspaceTabs | null = null;
    let version = -1;
    let pending: WorkspaceTabIntent[] = [];
    const pendingAliases = new Map<string, Readonly<{ id: string; kind: string }>>();
    let enrollmentCount = 0;
    let status: WorkspaceTabsSyncSnapshot['status'] = 'pending';
    let queue: Promise<void> = Promise.resolve();
    const current = () => !stopped && (input.shouldContinue?.() ?? true);
    const normalize = (value: SharedWorkspaceTabs) => input.normalizeRecord?.(value) ?? value;
    const rememberNormalizedAliases = (before: SharedWorkspaceTabs, after: SharedWorkspaceTabs) => {
        // A currently retained identity is an alias root, including one restored by a peer.
        for (const id of after.order) pendingAliases.delete(id);
        for (const id of before.order) {
            if (after.tabsById[id]) continue;
            const incumbent = after.order.find(kept => after.tabsById[kept].target.kind === before.tabsById[id].target.kind);
            if (incumbent) pendingAliases.set(id, { id: incumbent, kind: before.tabsById[id].target.kind });
        }
    };
    const normalizeWithAliases = (value: SharedWorkspaceTabs) => {
        const normalized = normalize(value);
        rememberNormalizedAliases(value, normalized);
        return normalized;
    };
    const resolvePendingId = (id: string): string => {
        const original = id;
        const kind = pendingAliases.get(id)?.kind;
        while (pendingAliases.has(id)) {
            const alias = pendingAliases.get(id)!;
            if (alias.kind !== kind) return original;
            id = alias.id;
        }
        // A peer can close or retarget the winner; neither retires the original operation.
        const winner = record?.tabsById[id];
        return winner && (kind === undefined || winner.target.kind === kind) ? id : original;
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
    const projected = () => record ? normalize(applyWorkspaceTabIntents(record,
        version === -1 && !pending.length ? input.enroll?.() ?? [] : pending.map(rebasePendingIntent))) : null;
    const snapshot = (): WorkspaceTabsSyncSnapshot => ({ status, record: projected() });
    const notify = () => { if (current()) input.onStatus?.(snapshot()); };
    const project = () => {
        if (!current()) return;
        if (record) record = normalizeWithAliases(record);
        const value = projected();
        if (value) input.onRecord(value);
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
                // Keep only pending-operation aliases; nothing is persisted or retained after drain.
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
            if (!pending.length) pendingAliases.clear();
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
        stop: () => { stopped = true; pending = []; pendingAliases.clear(); },
        getSnapshot: snapshot,
    };
}
