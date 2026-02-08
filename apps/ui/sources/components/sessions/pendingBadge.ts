export function formatPendingCountBadge(pendingCount: number): string | null {
    if (!Number.isFinite(pendingCount) || pendingCount <= 0) {
        return null;
    }

    return pendingCount > 99 ? '99+' : String(Math.floor(pendingCount));
}
