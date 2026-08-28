export function resolveExternalSessionAttachLeaseTtlMs(requestedTtlMs: number | undefined): number {
    const envRaw = Number.parseInt(String(process.env.HAPPIER_EXTERNAL_SESSIONS_ATTACH_LEASE_TTL_MS ?? ''), 10);
    const defaultTtlMs = Number.isFinite(envRaw) && envRaw > 0 ? Math.trunc(envRaw) : 45_000;
    const candidate = typeof requestedTtlMs === 'number' && Number.isFinite(requestedTtlMs) && requestedTtlMs > 0
        ? Math.trunc(requestedTtlMs)
        : defaultTtlMs;
    return Math.max(1_000, Math.min(15 * 60_000, candidate));
}
