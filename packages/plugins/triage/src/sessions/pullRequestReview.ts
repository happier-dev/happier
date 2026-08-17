import type { SessionId } from '@happier-dev/plugin-sdk/sessions';

import type { TriageEntrySessionStartResultV1 } from './entrySessionOrchestrator.js';

/**
 * Whether a settled Triage Session start may go on to ask for an agent review.
 *
 * Only the Fix/review arm that prepared the selected workspace for the exact
 * account and pull request may start one (`core/SESSIONS.md` §5.2). The
 * decision is made once, here, from facts the start already carries: the source
 * reauthorized the account, authoritatively reread the pull request and matched
 * base, head and native revision before it materialized anything, and it
 * reported the resulting local HEAD as the eligibility this reads. There is no
 * second read, no worktree inspection, no cache age and no freshness flag.
 *
 * The one pair a review may ever be scoped to is the pair this start observed.
 *
 * The scope this pair is carried in belongs to the canonical SCM/Reviews seam,
 * not to Triage (`CONTRACT.md` §5.4): that seam owns the strict
 * `ScmPullRequestReviewScopeV1` schema, its producer, and the top-level
 * `review.start` input key it travels under. Triage supplies the observed pair
 * and the already-selected account to that producer and passes its result
 * through unchanged; it parses no scope, mints no key, and keeps no engine
 * registry, findings store or fan-out of its own, because `review.start` is
 * already the fan-out owner.
 */
export type TriagePullRequestReviewRefusalV1 =
    /** Ask, a selected project, or an existing Session: no prepared review workspace. */
    | 'noPreparedReviewWorkspace'
    /** Creation, linking or opening did not settle, so there is no Session to review in. */
    | 'noStableSession'
    /** The source deliberately preserved local work at a head nobody reviewed. */
    | 'localHeadStale'
    /** The prepared head is not the head this start observed. */
    | 'observedHeadMismatch';

export type TriagePullRequestReviewStartV1 =
    | Readonly<{
        status: 'eligible';
        sessionId: SessionId;
        baseSha: string;
        headSha: string;
    }>
    | Readonly<{ status: 'ineligible'; reason: TriagePullRequestReviewRefusalV1 }>;

export function resolvePullRequestReviewStart(
    result: TriageEntrySessionStartResultV1,
): TriagePullRequestReviewStartV1 {
    // A pending link or open still names a Session id. Reviewing in it would
    // review under a relationship that was never committed, in a Session the
    // reader was never taken to.
    if (result.type !== 'opened') return { status: 'ineligible', reason: 'noStableSession' };

    const workspace = result.workspace;
    if (workspace.kind !== 'preparedReviewWorkspace') {
        return { status: 'ineligible', reason: 'noPreparedReviewWorkspace' };
    }

    const eligibility = workspace.reviewEligibility;
    if (eligibility.status !== 'eligible') {
        // The reason is the product answer, not a detail: "we cannot describe
        // those commits because your worktree still holds local work" and "we
        // cannot describe them because the pull request moved" need different
        // things from the reader, and collapsing them into one refusal tells
        // them to fix the wrong thing.
        return { status: 'ineligible', reason: eligibility.reason };
    }
    return {
        status: 'eligible',
        sessionId: result.sessionId,
        baseSha: eligibility.baseSha,
        headSha: eligibility.headSha,
    };
}
