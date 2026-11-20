/** Newer child evidence can outlive the owning session's last attachment observation. */
export function isSessionOwnedActivityUnobserved(
    runtimeLostSinceMs: number | null | undefined,
    latestObservedAtMs: number | null | undefined,
): boolean {
    return runtimeLostSinceMs != null
        && !(typeof latestObservedAtMs === 'number' && Number.isFinite(latestObservedAtMs)
            && latestObservedAtMs > runtimeLostSinceMs);
}
