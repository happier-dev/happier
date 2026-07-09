/**
 * A realtime provider auth failure carrying the originating HTTP status.
 *
 * Thrown when a BYO (bring-your-own-key) provider token/credential request is
 * rejected by the upstream provider with an auth status (401 Unauthorized /
 * 403 Forbidden). An invalid API key is a PERMANENT failure: retrying the same
 * bad key is futile, so the realtime classifier routes this through the
 * non-recoverable path (hard `error`, dismiss-required) instead of the
 * recoverable reconnect loop.
 *
 * Carrying the status structurally avoids brittle parsing of error message
 * strings in the classifier.
 */
export class RealtimeProviderAuthError extends Error {
    readonly status: number;

    constructor(params: Readonly<{ status: number; message?: string }>) {
        super(params.message ?? `Realtime provider auth failed (${params.status})`);
        this.name = 'RealtimeProviderAuthError';
        this.status = params.status;
    }
}

/** HTTP statuses that mark a provider auth/credential failure as non-recoverable. */
const NON_RECOVERABLE_AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * True when `error` is a provider auth failure that must NOT be retried (an
 * invalid/forbidden credential). Structural: keys off the typed error's status,
 * never the message text.
 */
export function isNonRecoverableProviderAuthError(error: unknown): error is RealtimeProviderAuthError {
    return error instanceof RealtimeProviderAuthError && NON_RECOVERABLE_AUTH_STATUSES.has(error.status);
}
