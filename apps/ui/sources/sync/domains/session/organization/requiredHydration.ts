import type { SessionOrganizationProjection } from './types';

/**
 * The organization rows the session list must hold no matter where the cursor page ends.
 *
 * Both members are user-declared placements the list cannot honour without the row itself: a pinned
 * session, and a session the user explicitly kept in Needs attention. The list page is ordered by
 * activity, so either can sit arbitrarily far past the first page while its organization record — a
 * whole-account snapshot — arrives immediately; the placement is then computed correctly against a
 * row that is not there.
 *
 * Only an EXPLICIT standing qualifies. Standing derived from the account default names every quiet
 * session on the account, which is not a required-row set, and the default's own placement is a
 * floor over rows the list already holds.
 *
 * This is the single owner of that set, so a caller cannot honour one member and drop the other.
 */
export function listSessionOrganizationRequiredHydrationSessionIds(
    projection: SessionOrganizationProjection | null | undefined,
): string[] {
    if (!projection || projection.version == null) return [];
    const sessionIds: string[] = [];
    const seen = new Set<string>();
    const append = (sessionId: string): void => {
        const id = String(sessionId ?? '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        sessionIds.push(id);
    };
    for (const sessionId of projection.pinnedSessionIds) {
        append(sessionId);
    }
    for (const standing of Object.values(projection.attentionStandingsBySessionId)) {
        if (standing.standing === true) append(standing.sessionId);
    }
    return sessionIds;
}
