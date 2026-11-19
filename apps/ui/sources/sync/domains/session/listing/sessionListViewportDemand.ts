type ViewportRow = Readonly<{ serverId: string | null; sessionId: string }>;

const displayedRowsByViewport = new Set<ReadonlyMap<string, ReadonlySet<string>>>();

/** A presented list's viewport is a metadata consumer, independent of any open transcript. */
export function registerSessionListViewportDemand(rows: readonly ViewportRow[]): () => void {
    const byServer = new Map<string, Set<string>>();
    for (const { serverId, sessionId } of rows) {
        if (!serverId) continue;
        let ids = byServer.get(serverId);
        if (!ids) {
            ids = new Set();
            byServer.set(serverId, ids);
        }
        ids.add(sessionId);
    }
    displayedRowsByViewport.add(byServer);
    return () => { displayedRowsByViewport.delete(byServer); };
}

export function isSessionListViewportRowDemanded(serverId: string | null | undefined, sessionId: string): boolean {
    if (!serverId) return false;
    for (const viewport of displayedRowsByViewport) {
        if (viewport.get(serverId)?.has(sessionId)) return true;
    }
    return false;
}

export function getSessionListViewportDemandedIds(serverId: string | null | undefined): string[] {
    if (!serverId) return [];
    const ids = new Set<string>();
    for (const viewport of displayedRowsByViewport) {
        for (const sessionId of viewport.get(serverId) ?? []) ids.add(sessionId);
    }
    return [...ids];
}
