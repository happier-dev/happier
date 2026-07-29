import type {
    QualifiedConnectedAccountQuotaSnapshotV4,
} from '@happier-dev/protocol';

import {
    readQualifiedConnectedAccountQuota,
    refreshQualifiedConnectedAccountQuota,
    type QualifiedConnectedAccountQuotaTransportContext,
} from './qualifiedConnectedAccountQuotaTransport';

export type QualifiedQuotaSnapshotStoreContext =
    QualifiedConnectedAccountQuotaTransportContext & Readonly<{
        credentialScope: string;
    }>;

export type QualifiedQuotaSnapshotStoreEntry = Readonly<{
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4 | null;
    supported: boolean | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
}>;

type InternalEntry = {
    snapshot: QualifiedConnectedAccountQuotaSnapshotV4 | null;
    supported: boolean | null;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    loadAttempted: boolean;
    loadPromise:
        Promise<QualifiedConnectedAccountQuotaSnapshotV4 | null> | null;
    refreshPromise: Promise<void> | null;
    nextFetchAtMs: number;
    retainCount: number;
    pollTimer: ReturnType<typeof setTimeout> | null;
    pollContext: QualifiedQuotaSnapshotStoreContext | null;
    view: QualifiedQuotaSnapshotStoreEntry;
};

const QUOTA_SNAPSHOT_POLL_MS = 30_000;
const QUOTA_SNAPSHOT_MISS_RETRY_MS = 30_000;
const QUOTA_SNAPSHOT_ERROR_RETRY_MS = 30_000;
const EMPTY_VIEW: QualifiedQuotaSnapshotStoreEntry = Object.freeze({
    snapshot: null,
    supported: null,
    loading: false,
    refreshing: false,
    error: null,
});

const entries = new Map<string, InternalEntry>();
const listenersByKey = new Map<string, Set<() => void>>();

function readErrorCode(error: unknown): string {
    if (error && typeof error === 'object') {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.trim()) return code;
    }
    return 'connected_service_request_failed';
}

export function buildQualifiedQuotaSnapshotScopeKey(
    context: Pick<
        QualifiedQuotaSnapshotStoreContext,
        'credentialScope' | 'ref' | 'serverBasis'
    >,
): string {
    return JSON.stringify([
        context.credentialScope,
        context.serverBasis.serverId,
        context.serverBasis.generation,
        context.ref.service.pluginId,
        context.ref.service.localId,
        context.ref.accountId,
    ]);
}

function getOrCreateEntry(key: string): InternalEntry {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: InternalEntry = {
        snapshot: null,
        supported: null,
        loading: false,
        refreshing: false,
        error: null,
        loadAttempted: false,
        loadPromise: null,
        refreshPromise: null,
        nextFetchAtMs: 0,
        retainCount: 0,
        pollTimer: null,
        pollContext: null,
        view: EMPTY_VIEW,
    };
    entries.set(key, created);
    return created;
}

function publish(key: string, entry: InternalEntry): void {
    entry.view = Object.freeze({
        snapshot: entry.snapshot,
        supported: entry.supported,
        loading: entry.loading,
        refreshing: entry.refreshing,
        error: entry.error,
    });
    const listeners = listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
}

function clearPollTimer(entry: InternalEntry): void {
    if (!entry.pollTimer) return;
    clearTimeout(entry.pollTimer);
    entry.pollTimer = null;
}

function schedulePolling(key: string): void {
    const entry = entries.get(key);
    if (
        !entry
        || entry.retainCount <= 0
        || entry.loadPromise
        || entry.refreshPromise
        || !entry.pollContext
    ) return;
    clearPollTimer(entry);
    entry.pollTimer = setTimeout(() => {
        entry.pollTimer = null;
        if (
            entry.retainCount <= 0
            || entry.loadPromise
            || entry.refreshPromise
            || !entry.pollContext
        ) return;
        void runLoad(key, entry.pollContext);
    }, Math.max(0, entry.nextFetchAtMs - Date.now()));
}

async function runLoad(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): Promise<QualifiedConnectedAccountQuotaSnapshotV4 | null> {
    const entry = getOrCreateEntry(key);
    if (entry.loadPromise) return entry.loadPromise;
    clearPollTimer(entry);
    entry.loading = true;
    entry.error = null;
    publish(key, entry);

    const promise = (async () => {
        try {
            const snapshot =
                await readQualifiedConnectedAccountQuota(context);
            entry.snapshot = snapshot;
            entry.supported = snapshot !== null;
            entry.error = null;
            entry.nextFetchAtMs = Date.now() + (
                snapshot
                    ? Math.max(
                        QUOTA_SNAPSHOT_POLL_MS,
                        Math.trunc(
                            snapshot.staleAfterMs
                            ?? QUOTA_SNAPSHOT_POLL_MS,
                        ),
                    )
                    : QUOTA_SNAPSHOT_MISS_RETRY_MS
            );
            return snapshot;
        } catch (error) {
            entry.supported = true;
            entry.error = readErrorCode(error);
            entry.nextFetchAtMs =
                Date.now() + QUOTA_SNAPSHOT_ERROR_RETRY_MS;
            return null;
        } finally {
            entry.loading = false;
            entry.loadPromise = null;
            publish(key, entry);
            schedulePolling(key);
        }
    })();
    entry.loadPromise = promise;
    return promise;
}

export function getQualifiedQuotaSnapshotEntry(
    key: string | null,
): QualifiedQuotaSnapshotStoreEntry {
    if (!key) return EMPTY_VIEW;
    return entries.get(key)?.view ?? EMPTY_VIEW;
}

export function subscribeQualifiedQuotaSnapshotEntry(
    key: string | null,
    listener: () => void,
): () => void {
    if (!key) return () => {};
    let listeners = listenersByKey.get(key);
    if (!listeners) {
        listeners = new Set();
        listenersByKey.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) listenersByKey.delete(key);
    };
}

export function retainQualifiedQuotaSnapshotPolling(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): () => void {
    const entry = getOrCreateEntry(key);
    entry.retainCount += 1;
    entry.pollContext = context;
    if (
        !entry.loadAttempted
        || (!entry.loadPromise && Date.now() >= entry.nextFetchAtMs)
    ) {
        entry.loadAttempted = true;
        void runLoad(key, context);
    } else {
        schedulePolling(key);
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        entry.retainCount = Math.max(0, entry.retainCount - 1);
        if (entry.retainCount === 0) {
            entry.pollContext = null;
            clearPollTimer(entry);
        }
    };
}

export async function refreshQualifiedQuotaSnapshot(
    key: string,
    context: QualifiedQuotaSnapshotStoreContext,
): Promise<void> {
    const entry = getOrCreateEntry(key);
    if (entry.refreshPromise) return entry.refreshPromise;
    clearPollTimer(entry);
    entry.snapshot = null;
    entry.refreshing = true;
    entry.error = null;
    publish(key, entry);

    const promise = (async () => {
        try {
            await entry.loadPromise;
            await refreshQualifiedConnectedAccountQuota(context);
            await runLoad(key, context);
        } catch (error) {
            entry.supported = true;
            entry.error = readErrorCode(error);
        } finally {
            entry.refreshPromise = null;
            entry.refreshing = false;
            publish(key, entry);
            schedulePolling(key);
        }
    })();
    entry.refreshPromise = promise;
    return promise;
}

export function __resetQualifiedConnectedAccountQuotaSnapshotStore(): void {
    for (const entry of entries.values()) clearPollTimer(entry);
    entries.clear();
    listenersByKey.clear();
}
