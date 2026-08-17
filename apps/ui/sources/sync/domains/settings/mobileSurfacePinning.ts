/**
 * Session cockpit bottom chrome reserves one slot for overflow whenever the
 * catalog is larger than its inline capacity. Keep the durable pin list below
 * that capacity so a contributor cannot crowd out the host's navigation.
 */
export const SESSION_COCKPIT_MAX_PINNED_SURFACE_COUNT = 3;

function normalizeSurfaceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Retain only qualified, user-owned identifiers. Callers decide whether an id
 * is currently admitted; unavailable plugin pins remain durable so a later
 * reinstatement can restore the user's preference without becoming visible in
 * the interim.
 */
export function toggleSessionCockpitPinnedSurface(
    pinnedSurfaceIds: readonly string[] | null | undefined,
    surfaceId: string,
): readonly string[] {
    const normalizedSurfaceId = normalizeSurfaceId(surfaceId);
    if (!normalizedSurfaceId) {
        return Array.isArray(pinnedSurfaceIds) ? pinnedSurfaceIds : [];
    }

    const seen = new Set<string>();
    const normalizedPinned = (pinnedSurfaceIds ?? []).flatMap((candidate) => {
        const normalizedCandidate = normalizeSurfaceId(candidate);
        if (!normalizedCandidate || seen.has(normalizedCandidate)) return [];
        seen.add(normalizedCandidate);
        return [normalizedCandidate];
    });
    const existingIndex = normalizedPinned.indexOf(normalizedSurfaceId);
    if (existingIndex >= 0) {
        return Object.freeze(normalizedPinned.filter((candidate) => candidate !== normalizedSurfaceId));
    }

    // The newest explicit request wins at the bounded host capacity. This is
    // deterministic and keeps the selected item visible without letting a
    // plugin-defined rank dictate permanent chrome placement.
    return Object.freeze([
        ...normalizedPinned,
        normalizedSurfaceId,
    ].slice(-SESSION_COCKPIT_MAX_PINNED_SURFACE_COUNT));
}
