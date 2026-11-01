import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { SessionListViewItem } from './sessionListViewData';

export type SessionArchiveOperation = Readonly<{ serverId: string; sessionId: string }>;
export type SessionArchiveOperations = Readonly<Record<string, Readonly<Record<string, SessionArchiveOperation>>>>;

export function resolveSessionArchiveServerId(serverId?: string | null): string {
    return resolveServerProfileScopeIdForIdentifier(serverId ?? getActiveServerSnapshot().serverId);
}

export function readSessionArchivePending(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    sessionId: string,
    serverId: string,
): boolean {
    const operations = state.sessionArchiveOperations;
    if (operations?.[serverId]?.[sessionId]) return true;
    // A feature response can establish the server identity after admission.
    // Keep the captured operation unchanged so only its own completion can settle it.
    let currentServerId: string | undefined;
    for (const [capturedServerId, bucket] of Object.entries(operations ?? {})) {
        if (!bucket[sessionId]) continue;
        currentServerId ??= resolveSessionArchiveServerId(serverId);
        if (resolveSessionArchiveServerId(capturedServerId) === currentServerId) return true;
    }
    return false;
}

/** Selected IDs are current canonical scopes; admitted operations may predate identity discovery. */
export function readSessionArchiveOperationsForServers(
    state: Readonly<{ sessionArchiveOperations?: SessionArchiveOperations }>,
    serverIds: readonly string[],
): SessionArchiveOperation[] {
    const selected = new Set(serverIds);
    return Object.entries(state.sessionArchiveOperations ?? {}).flatMap(([capturedServerId, bucket]) => (
        selected.has(capturedServerId) || selected.has(resolveSessionArchiveServerId(capturedServerId))
            ? Object.values(bucket)
            : []
    ));
}

/** Pending operations retain their row without modifying server-owned runtime or cached snapshots. */
export function projectSessionArchivesToListViewData(
    source: SessionListViewItem[] | null,
    operations: readonly SessionArchiveOperation[],
    activeServerId: string,
): SessionListViewItem[] | null {
    if (!source || operations.length === 0) return source;
    const canonicalServerIds = new Map<string, string>();
    const resolveServerId = (serverId: string) => {
        let canonical = canonicalServerIds.get(serverId);
        if (canonical === undefined) {
            canonical = resolveSessionArchiveServerId(serverId);
            canonicalServerIds.set(serverId, canonical);
        }
        return canonical;
    };
    const pendingByServer = new Map<string, Set<string>>();
    const pendingSessionIds = new Set<string>();
    for (const operation of operations) {
        const serverId = resolveServerId(operation.serverId);
        let ids = pendingByServer.get(serverId);
        if (!ids) pendingByServer.set(serverId, ids = new Set());
        ids.add(operation.sessionId);
        pendingSessionIds.add(operation.sessionId);
    }
    let changed = false;
    const projected = source.map((item) => {
        if (item.type !== 'session' || !pendingSessionIds.has(item.session.id)) return item;
        const serverId = item.serverId ?? activeServerId;
        if (!pendingByServer.get(serverId)?.has(item.session.id)
            && !pendingByServer.get(resolveServerId(serverId))?.has(item.session.id)) return item;
        changed = true;
        return { ...item, session: { ...item.session, archiving: true, keepVisibleWhenInactive: true } };
    });
    return changed ? projected : source;
}
