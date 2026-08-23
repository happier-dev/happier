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

/**
 * The exact conclusion is unavailable; this is the common case, not an error path.
 *
 * It carries the classified provider failure verbatim, and nothing else. What the
 * provider answered has ONE projection owner — `operations.ts#toTriageSourceFailure`
 * — and it needs the failure itself. A second switch stood here, mapping the same
 * input onto a parallel reason vocabulary, and it had already dropped the
 * provider's `Retry-After` deadline that the same condition carries through
 * `scan`; once the failure travelled whole, nothing read the reasons and they were
 * a classification kept in step by hand with the one that decides.
 */
export type PosthogUnresolvedIssue = Readonly<{
    kind: 'unresolved';
    failure: PosthogFailure;
}>;

export type PosthogIssueResolution =
    /** The issue was read authoritatively. */
    | Readonly<{ kind: 'present' }>
    | PosthogUnresolvedIssue;

/**
 * States that a CRUD-plane failure leaves the entry unresolved.
 *
 * V1 has no arm that produces `absent` or `merged`, and adding one requires
 * authoritative API evidence for that exact conclusion — never scan coverage,
 * cache state, or UI inference. That conclusion is the whole of what this decides;
 * what the failure MEANS to a reader is the projection owner's answer.
 */
export function resolvePosthogCrudFailure(failure: PosthogFailure): PosthogUnresolvedIssue {
    return { kind: 'unresolved', failure };
}
