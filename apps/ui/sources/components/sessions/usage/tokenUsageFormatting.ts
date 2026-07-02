function trimTrailingZero(value: string): string {
    return value.endsWith('.0') ? value.slice(0, -2) : value;
}

function normalizeUsageNumber(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function formatTokenUsagePercent(value: number): string {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    return `${trimTrailingZero(safeValue.toFixed(1))}%`;
}

export function formatTokenUsageCount(value: number): string {
    const safeValue = normalizeUsageNumber(value);
    if (safeValue >= 1_000_000) {
        return `${trimTrailingZero((safeValue / 1_000_000).toFixed(safeValue >= 10_000_000 ? 0 : 1))}M`;
    }
    if (safeValue >= 1_000) {
        return `${trimTrailingZero((safeValue / 1_000).toFixed(safeValue >= 100_000 ? 0 : 1))}k`;
    }
    return String(safeValue);
}

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
