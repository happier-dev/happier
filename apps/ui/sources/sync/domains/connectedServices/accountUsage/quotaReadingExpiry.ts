/**
 * A reading keeps its value and reset when its producer's freshness window ends.
 * This deadline only decides when its presentation must say that it is old.
 */
export function resolveQuotaReadingExpiry(
    readingAtMs: number | null | undefined,
    staleAfterMs: number | undefined,
): number | null {
    return readingAtMs == null || staleAfterMs === undefined ? null : readingAtMs + staleAfterMs;
}

export function isQuotaReadingExpired(expiresAtMs: number | null, nowMs: number): boolean {
    return expiresAtMs !== null && expiresAtMs <= nowMs;
}
