import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Scoped run-materialization capability token (least privilege).
 *
 * Execution-run runners ask the daemon (the sole connected-services owner) to resolve +
 * materialize connected-service auth for a RUN-scoped materialization key. The runner must NOT
 * hold the daemon's full `controlToken` scope for this. The daemon accepts a NARROW capability
 * token derived deterministically from the master control token:
 *
 *   token = base64url( HMAC-SHA256(controlToken, RUN_MATERIALIZE_SCOPE_LABEL) )
 *
 * Properties:
 *  - No extra persisted secret / no parallel token store; the daemon re-derives and constant-time
 *    compares against its in-memory master token.
 *  - A daemon restart re-mints `controlToken`, rotating the scoped token.
 *  - The scoped token never matches the broad master comparison.
 */
export const CONNECTED_SERVICE_RUN_MATERIALIZE_SCOPE_LABEL = 'happier:connected-service-run-materialize:v1';

/**
 * Derive the scoped run-materialize capability token from the daemon master control token.
 * Returns an empty string for an empty/blank control token (fail-closed: empty never authorizes).
 */
export function deriveConnectedServiceRunMaterializeToken(controlToken: string | null | undefined): string {
    const normalized = typeof controlToken === 'string' ? controlToken.trim() : '';
    if (!normalized) return '';
    return createHmac('sha256', normalized)
        .update(CONNECTED_SERVICE_RUN_MATERIALIZE_SCOPE_LABEL)
        .digest('base64url');
}

/**
 * Constant-time verification that `provided` is the scoped run-materialize token for
 * `controlToken`. Fails closed on any empty/blank input.
 */
export function isValidConnectedServiceRunMaterializeToken(
    provided: string | null | undefined,
    controlToken: string | null | undefined,
): boolean {
    const expected = deriveConnectedServiceRunMaterializeToken(controlToken);
    const candidate = typeof provided === 'string' ? provided.trim() : '';
    if (!expected || !candidate) return false;
    const expectedDigest = createHash('sha256').update(expected).digest();
    const candidateDigest = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(expectedDigest, candidateDigest);
}
