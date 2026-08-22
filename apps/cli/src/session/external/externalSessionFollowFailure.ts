/**
 * Host-owned typed failures of the External Sessions follow corridor.
 *
 * Agent-owned failures keep using `ExternalSessionProviderFailureError`; these
 * are the conditions the host itself decides — no current Agent runtime
 * generation, a linked source that changed or was retired mid-flight, live
 * follow that could not be admitted, and a disposed follow-lease owner. They
 * exist so the daemon action surfaces can answer with the failure class instead
 * of collapsing every unexpected throw into `internal_error`.
 */
export type ExternalSessionFollowFailureKind =
    /** No current Agent runtime generation can serve the linked session. */
    | 'agent_unavailable'
    /** The linked source, link generation, or plugin generation changed. */
    | 'source_changed'
    /** Live follow is not available for this link (unsupported or unadmitted). */
    | 'follow_unavailable'
    /** The follow-lease owner is shutting down. */
    | 'daemon_unavailable';

export class ExternalSessionFollowFailureError extends Error {
    readonly kind: ExternalSessionFollowFailureKind;

    constructor(kind: ExternalSessionFollowFailureKind, message: string) {
        super(message);
        this.name = 'ExternalSessionFollowFailureError';
        this.kind = kind;
    }
}

export function isExternalSessionFollowFailureError(
    error: unknown,
): error is ExternalSessionFollowFailureError {
    return error instanceof ExternalSessionFollowFailureError;
}
