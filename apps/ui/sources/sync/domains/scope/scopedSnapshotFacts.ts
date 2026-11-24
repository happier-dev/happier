/**
 * The shared vocabulary for server-Account-scoped, reconstructible snapshots.
 *
 * Home governance and Teams are woken by the same content-free Account-change
 * signal and must agree on what "stale", "reachable" and "retryable" mean, so
 * these facts live in one place. Each domain still owns its own store, keys and
 * lifecycle: this module defines the vocabulary, not a generic cache.
 *
 * It lives with the other scope vocabulary rather than in a store because the
 * meaning of a Home's answer is domain behavior. Stores, engines, hooks and
 * surfaces all consume it, and a domain module may not depend on a store.
 */

/**
 * Loading is kept separate from the observation itself so a refresh can never
 * blank an already-rendered surface. `refreshing` means data is on screen.
 */
export type ScopedSnapshotStatus = 'loading' | 'refreshing' | 'ready' | 'error';

export type ScopedSnapshotReachability = 'unknown' | 'reachable' | 'unreachable' | 'unauthorized';

/**
 * The retry-facing failure. The kind is the exact Home's answer rather than a
 * message: `unauthorized`, `forbidden` and `unsupported` are settled outcomes,
 * while `unreachable` and `unknown` are worth retrying.
 */
export type ScopedSnapshotError = Readonly<{
    kind:
        | 'unreachable'
        | 'unauthorized'
        | 'forbidden'
        /** The Home answered that it has no such operation: older or disabled. */
        | 'unsupported'
        | 'invalid'
        | 'unknown';
    retryable: boolean;
    /** Optional domain-owned typed code carried without reclassifying it here. */
    code?: string | null;
    /** The Home's strict error envelope for that code, carried the same way. */
    details?: unknown;
}>;

/**
 * Only an answer proves reachability. `forbidden`, `unsupported` and `invalid`
 * came from the Home itself, so they leave it reachable; `unknown` claims
 * nothing. One owner decides this for every scoped snapshot domain.
 */
export function reachabilityForScopedSnapshotError(
    error: ScopedSnapshotError,
): ScopedSnapshotReachability {
    if (error.kind === 'unreachable') return 'unreachable';
    if (error.kind === 'unauthorized') return 'unauthorized';
    if (error.kind === 'unknown') return 'unknown';
    return 'reachable';
}

/**
 * Whether the Home has authoritatively withdrawn this snapshot.
 *
 * A retained projection is what keeps a surface useful while a Home is offline,
 * but that retention must not outlive an answer. `unauthorized`, `forbidden`
 * and `unsupported` are statements the Home made about this Account or about
 * itself — the credential no longer authenticates, the authority is gone, or
 * the operation does not exist there. Continuing to render retained content as
 * merely stale after one of those would show someone an authority they have
 * been told they do not have.
 *
 * `unreachable`, `invalid` and `unknown` are not such statements: they leave
 * the last successful observation standing.
 */
export function isAuthoritativeScopedSnapshotRefusal(
    error: ScopedSnapshotError | null | undefined,
): error is ScopedSnapshotError & Readonly<{ kind: 'unauthorized' | 'forbidden' | 'unsupported' }> {
    if (!error) return false;
    return error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'unsupported';
}

/** Shared form for reducers whose richer error envelope has the same kind. */
export function isAuthoritativeScopedSnapshotRefusalKind(kind: string): boolean {
    return kind === 'unauthorized' || kind === 'forbidden' || kind === 'unsupported';
}
