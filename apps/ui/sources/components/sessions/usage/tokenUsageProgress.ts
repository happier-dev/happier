export function resolveTokenUsageProgressRatio(params: Readonly<{
    used: number;
    limit: number | null | undefined;
}>): number {
    const safeLimit = typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
        ? params.limit
        : null;
    if (safeLimit === null) return 0;

    const safeUsed = Number.isFinite(params.used) ? Math.max(0, params.used) : 0;
    return Math.max(0, Math.min(safeUsed / safeLimit, 1));
}
