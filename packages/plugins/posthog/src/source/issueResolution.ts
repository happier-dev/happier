/**
 * Issue-resolution semantics.
 *
 * PostHog can name a merge successor only when the request also supplies a fingerprint:
 * a fingerprint resolves to the issue it *currently* belongs to. V1 retains no
 * fingerprint in any entry, observation, locator, or configuration, so it can never
 * make that qualified request and can never observe a successor.
 *
 * A plain exact-id 404 therefore cannot distinguish deletion from a merge from any
 * other missing-row condition, and it resolves to `unresolved`, never `absent`. Nothing
 * else establishes absence either: a query-plane 404 is window-scoped (an issue that
 * stopped firing before the configured window looks identical to a deleted one), scan
 * membership is not a set complement, and permission, throttle, transport, and
 * cancellation failures are all unresolved by construction.
 */

import type { PosthogFailure } from '../api/errors.js';

export type PosthogIssueResolution =
    /** The issue was read authoritatively. */
    | Readonly<{ kind: 'present' }>
    /** The exact conclusion is unavailable; this is the common case, not an error path. */
    | Readonly<{ kind: 'unresolved'; because: PosthogUnresolvedReason }>;

export type PosthogUnresolvedReason =
    | 'plainNotFound'
    | 'authentication'
    | 'permission'
    | 'rateLimited'
    | 'redirected'
    | 'transient'
    | 'transport'
    | 'malformedResponse'
    | 'cancelled'
    | 'configuration';

/**
 * Maps a CRUD-plane failure to an unresolved reason. V1 has no arm that produces
 * `absent` or `merged`, and adding one requires authoritative API evidence for that
 * exact conclusion — never scan coverage, cache state, or UI inference.
 */
export function resolvePosthogCrudFailure(failure: PosthogFailure): PosthogIssueResolution {
    switch (failure.kind) {
        case 'notFound':
            return { kind: 'unresolved', because: 'plainNotFound' };
        case 'unauthorized':
            return { kind: 'unresolved', because: 'authentication' };
        case 'forbidden':
            return { kind: 'unresolved', because: 'permission' };
        case 'rateLimited':
            return { kind: 'unresolved', because: 'rateLimited' };
        case 'redirected':
            return { kind: 'unresolved', because: 'redirected' };
        case 'server':
        case 'timeout':
        case 'unexpectedStatus':
            return { kind: 'unresolved', because: 'transient' };
        case 'transport':
            return { kind: 'unresolved', because: 'transport' };
        case 'malformedResponse':
            return { kind: 'unresolved', because: 'malformedResponse' };
        case 'cancelled':
            return { kind: 'unresolved', because: 'cancelled' };
        case 'originMismatch':
        case 'requestInvalid':
            return { kind: 'unresolved', because: 'configuration' };
    }
}
