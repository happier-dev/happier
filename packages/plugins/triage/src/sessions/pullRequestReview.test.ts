import { describe, expect, it } from 'vitest';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';

import type { TriageEntrySessionStartResultV1 } from './entrySessionOrchestrator.js';
import type {
    TriageEntrySessionWorkspaceFactsV1,
    TriagePreparedReviewWorkspaceFactsV1,
    TriageReviewStartEligibilityV1,
} from './entrySessionWorkspace.js';
import { resolvePullRequestReviewStart } from './pullRequestReview.js';

/**
 * The Triage half of safe selected-PR review (`core/SESSIONS.md` §5.2).
 *
 * Every case here is a way a review could be started against commits nobody
 * looked at. The decision is made once, from the facts the settled start
 * already carries, and it invokes nothing at all — which is why these tests
 * need no host boundary to be discriminating.
 */

const SESSION_ID = 'session-7' as SessionId;
const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const OTHER_SHA = '3333333333333333333333333333333333333333';

function preparedWorkspace(
    reviewEligibility: TriageReviewStartEligibilityV1,
): TriagePreparedReviewWorkspaceFactsV1 {
    return {
        kind: 'preparedReviewWorkspace',
        directory: '/workspaces/acme/web',
        branch: 'pr-42',
        created: true,
        currentness: { kind: 'currentAtObservedHead' },
        reviewEligibility,
    };
}

const ELIGIBLE = preparedWorkspace({ status: 'eligible', baseSha: BASE_SHA, headSha: HEAD_SHA });

function opened(
    workspace: TriageEntrySessionWorkspaceFactsV1,
): TriageEntrySessionStartResultV1 {
    return { type: 'opened', sessionId: SESSION_ID, disposition: 'created', workspace };
}

describe('resolvePullRequestReviewStart', () => {
    it('admits the prepared workspace with the exact observed base and head', () => {
        expect(resolvePullRequestReviewStart(opened(ELIGIBLE))).toEqual({
            status: 'eligible',
            sessionId: SESSION_ID,
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
        });
    });

    it('refuses a reference-only Ask and a selected-project Fix', () => {
        expect(resolvePullRequestReviewStart(opened({ kind: 'referenceOnly' })))
            .toEqual({ status: 'ineligible', reason: 'noPreparedReviewWorkspace' });
        expect(resolvePullRequestReviewStart(
            opened({ kind: 'selectedProject', directory: '/workspaces/acme/web' }),
        )).toEqual({ status: 'ineligible', reason: 'noPreparedReviewWorkspace' });
    });

    it('refuses a worktree the source deliberately preserved at a stale head', () => {
        const stale = preparedWorkspace({
            status: 'ineligible',
            reason: 'localHeadStale',
            resolvedHeadSha: OTHER_SHA,
            observedHeadSha: HEAD_SHA,
            staleReason: 'dirtyWorktree',
        });

        expect(resolvePullRequestReviewStart(opened(stale)))
            .toEqual({ status: 'ineligible', reason: 'localHeadStale' });
    });

    it('refuses a head this start never observed', () => {
        const moved = preparedWorkspace({
            status: 'ineligible',
            reason: 'observedHeadMismatch',
            resolvedHeadSha: OTHER_SHA,
            observedHeadSha: HEAD_SHA,
        });

        expect(resolvePullRequestReviewStart(opened(moved)))
            .toEqual({ status: 'ineligible', reason: 'observedHeadMismatch' });
    });

    it('refuses every start that did not settle on one linked, opened Session', () => {
        // A pending link or open still names a Session id, and starting a review
        // against it would review commits under a relationship that was never
        // committed and a Session the reader is not looking at.
        const unsettled: readonly TriageEntrySessionStartResultV1[] = [
            { type: 'linkPending', sessionId: SESSION_ID, disposition: 'created', workspace: ELIGIBLE },
            { type: 'openPending', sessionId: SESSION_ID, disposition: 'created', workspace: ELIGIBLE },
            { type: 'creationPending', creationKey: 'key-1', outcome: 'accepted', workspace: ELIGIBLE },
            { type: 'creationFailed', creationKey: 'key-1', workspace: ELIGIBLE },
            { type: 'workspacePreparationFailed', reason: 'refused', retryable: false },
            { type: 'rejected', reason: 'existingSessionNotOfferedForFix' },
        ];

        for (const result of unsettled) {
            expect(resolvePullRequestReviewStart(result))
                .toEqual({ status: 'ineligible', reason: 'noStableSession' });
        }
    });

    it('refuses an Ask that reused an existing Session even when one is open', () => {
        expect(resolvePullRequestReviewStart({
            type: 'opened',
            sessionId: SESSION_ID,
            disposition: 'existing',
            workspace: { kind: 'referenceOnly' },
        })).toEqual({ status: 'ineligible', reason: 'noPreparedReviewWorkspace' });
    });
});
