export type SessionRouteHydrationMissingCause =
    | 'not_found'
    | 'unauthorized'
    | 'forbidden'
    | 'auth_unavailable';

export type SessionRouteHydrationRetryCause =
    | 'network'
    | 'server_unavailable'
    | 'decrypting'
    | 'unknown';

export type SessionRouteHydrationState =
    | Readonly<{
        kind: 'loading';
        sessionId: string;
        serverId?: string;
        reason: 'cold' | 'server-switch' | 'store-miss' | 'refreshing';
    }>
    | Readonly<{
        kind: 'available';
        sessionId: string;
        serverId?: string;
    }>
    | Readonly<{
        kind: 'retrying';
        sessionId: string;
        serverId?: string;
        cause: SessionRouteHydrationRetryCause;
    }>
    | Readonly<{
        kind: 'missing';
        sessionId: string;
        serverId?: string;
        cause: SessionRouteHydrationMissingCause;
    }>;

export type EnsureSessionVisibleForRouteResult =
    | Readonly<{
        kind: 'available';
        sessionId: string;
        serverId?: string;
    }>
    | Readonly<{
        kind: 'missing';
        sessionId: string;
        serverId?: string;
        cause: SessionRouteHydrationMissingCause;
    }>
    | Readonly<{
        kind: 'retryable_failure';
        sessionId: string;
        serverId?: string;
        cause: SessionRouteHydrationRetryCause;
    }>;

export function isSessionRouteHydrationAvailable(state: SessionRouteHydrationState): boolean {
    return state.kind === 'available';
}

export function isSessionRouteHydrationMissing(state: SessionRouteHydrationState): boolean {
    return state.kind === 'missing';
}

export function isSessionRouteHydrationPending(state: SessionRouteHydrationState): boolean {
    return state.kind === 'loading' || state.kind === 'retrying';
}
