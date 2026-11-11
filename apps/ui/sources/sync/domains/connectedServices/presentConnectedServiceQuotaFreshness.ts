/** Observation time shared by account detail, Credentials and pool freshness. */
export function presentConnectedServiceQuotaFreshness(
    snapshot: Readonly<{ state?: string; fetchedAt: number | null; staleAfterMs?: number }> | null | undefined,
    now: number,
): Readonly<{ fetchedAt: number | null; staleSince: number | null }> {
    // No-sample quota projections retain zero for the wire timestamp; it is not an observation.
    const fetchedAt = snapshot?.state === 'not_loaded' || !snapshot?.fetchedAt ? null : snapshot.fetchedAt;
    return {
        fetchedAt,
        staleSince: fetchedAt !== null && snapshot?.staleAfterMs !== undefined && now > fetchedAt + snapshot.staleAfterMs ? fetchedAt : null,
    };
}
