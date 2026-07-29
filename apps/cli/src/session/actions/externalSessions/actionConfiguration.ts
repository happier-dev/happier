export function resolveDefaultMaxBytes(): number {
    const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_PAGE_MAX_BYTES ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512_000;
    return Math.max(1024, Math.min(10 * 1024 * 1024, configured));
}

export function resolveDefaultMaxItems(): number {
    const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_PAGE_MAX_ITEMS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
    return Math.max(1, Math.min(5000, configured));
}

export function resolveDefaultCandidatesLimit(): number {
    const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_CANDIDATES_DEFAULT_LIMIT ?? ''), 10);
    const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 50;
    return Math.max(1, Math.min(500, configured));
}

export function resolveTakeoverReadinessCacheMs(): number {
    const raw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_STATUS_TAKEOVER_CACHE_MS ?? ''), 10);
    const configured = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 5_000;
    return Math.max(0, Math.min(10 * 60 * 1000, configured));
}

export function resolveExternalSessionAttachLeaseTtlMs(requestedTtlMs: number | undefined): number {
    const envRaw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_ATTACH_LEASE_TTL_MS ?? ''), 10);
    const defaultTtlMs = Number.isFinite(envRaw) && envRaw > 0 ? Math.trunc(envRaw) : 45_000;
    const candidate = typeof requestedTtlMs === 'number' && Number.isFinite(requestedTtlMs) && requestedTtlMs > 0
        ? Math.trunc(requestedTtlMs)
        : defaultTtlMs;
    return Math.max(1_000, Math.min(15 * 60_000, candidate));
}
