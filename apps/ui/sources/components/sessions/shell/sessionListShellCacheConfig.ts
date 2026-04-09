function parseBoundedPositiveInt(raw: string, fallback: number, min: number, max: number): number {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return fallback;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

export function readSessionListShellCacheMaxEntriesFromEnv(): number {
    return parseBoundedPositiveInt(
        String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_LIST_SHELL_CACHE_MAX ?? ''),
        512,
        1,
        100_000,
    );
}
