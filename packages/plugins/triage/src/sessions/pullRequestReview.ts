import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type {
    TriageEntryRefV1,
    TriageReviewWorkspaceObservedRevisionV1,
} from '@happier-dev/triage-protocol/v1';
import {
    produceScmPullRequestReviewScope,
    type ScmPullRequestReviewScopeV1,
} from '@happier-dev/plugin-sdk/reviews';

import type { TriageEntrySessionStartResultV1 } from './entrySessionOrchestrator.js';
import { sameTriageSourceIdentity } from '../corpus/identity/components.js';
import {
    readAvailableEngineOptions,
    type TriageReviewEngineOptionV1,
} from './reviewEngineOptions.js';

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

export type TriagePullRequestAuthoritativeReviewReadV1 =
    | Readonly<{ status: 'absent' }>
    | Readonly<{
        status: 'present';
        source: PluginContributionIdentity;
        account: QualifiedConnectedAccountRef;
        entryRef: TriageEntryRefV1;
        pullRequest: unknown;
        observed: TriageReviewWorkspaceObservedRevisionV1;
    }>;

export type TriagePullRequestReviewStartRefusalV1 =
    | TriagePullRequestReviewRefusalV1
    | 'sourceMismatch'
    | 'accountMismatch'
    | 'pullRequestMismatch'
    | 'observationMismatch'
    | 'scopeAbsent'
    | 'scopeMalformed'
    | 'engineListMalformed'
    | 'engineSelectionInvalid';

export type TriagePullRequestReviewRunResultV1 =
    | Readonly<{ status: 'started'; result: unknown }>
    | Readonly<{ status: 'refused'; reason: TriagePullRequestReviewStartRefusalV1 }>;

export type TriagePullRequestReviewStartDepsV1 = Readonly<{
    reread: () => Promise<TriagePullRequestAuthoritativeReviewReadV1>;
    execute: (actionId: string, input: unknown) => Promise<unknown>;
    selectEngineIds: (input: Readonly<{
        sessionId: SessionId;
        options: readonly TriageReviewEngineOptionV1[];
        scope: ScmPullRequestReviewScopeV1;
    }>) => Promise<readonly string[]>;
}>;

export type TriagePullRequestReviewStartRequestV1 = Readonly<{
    startResult: TriageEntrySessionStartResultV1;
    prepared: Readonly<{
        source: PluginContributionIdentity;
        account: QualifiedConnectedAccountRef;
        entryRef: TriageEntryRefV1;
        observed: TriageReviewWorkspaceObservedRevisionV1;
    }>;
    instructions: string;
}>;

function sameEntryRef(left: TriageEntryRefV1, right: TriageEntryRefV1): boolean {
    return sameTriageSourceIdentity(left.source, right.source)
        && left.kindId === right.kindId
        && left.collisionScope === right.collisionScope
        && left.entryId === right.entryId;
}

/**
 * Starts the incumbent multi-engine review exactly once after every fact that
 * scopes it has been re-established. This function owns sequencing only: the
 * SCM/Reviews producer owns the scope and `review.start` owns fan-out.
 */
export async function startPullRequestReview(
    deps: TriagePullRequestReviewStartDepsV1,
    request: TriagePullRequestReviewStartRequestV1,
): Promise<TriagePullRequestReviewRunResultV1> {
    const eligible = resolvePullRequestReviewStart(request.startResult);
    if (eligible.status === 'ineligible') {
        return { status: 'refused', reason: eligible.reason };
    }
    if (
        eligible.baseSha !== request.prepared.observed.baseSha
        || eligible.headSha !== request.prepared.observed.headSha
    ) {
        return { status: 'refused', reason: 'observationMismatch' };
    }

    const authoritative = await deps.reread();
    if (authoritative.status === 'absent') {
        return { status: 'refused', reason: 'scopeAbsent' };
    }
    if (!sameTriageSourceIdentity(authoritative.source, request.prepared.source)) {
        return { status: 'refused', reason: 'sourceMismatch' };
    }
    if (!sameEntryRef(authoritative.entryRef, request.prepared.entryRef)) {
        return { status: 'refused', reason: 'pullRequestMismatch' };
    }

    const produced = produceScmPullRequestReviewScope({
        authoritative: {
            account: authoritative.account,
            pullRequest: authoritative.pullRequest,
            observed: authoritative.observed,
        },
        expected: {
            account: request.prepared.account,
            baseSha: request.prepared.observed.baseSha,
            headSha: request.prepared.observed.headSha,
        },
    });
    if (produced.status === 'refused') {
        return {
            status: 'refused',
            reason: produced.reason === 'malformed' ? 'scopeMalformed' : produced.reason,
        };
    }

    const engineListResult = await deps.execute('review.engines.list', {
        sessionId: eligible.sessionId,
    });
    const options = readAvailableEngineOptions(engineListResult, eligible.sessionId);
    if (options === null) {
        return { status: 'refused', reason: 'engineListMalformed' };
    }
    const engineIds = await deps.selectEngineIds({
        sessionId: eligible.sessionId,
        options,
        scope: produced.scope,
    });
    const available = new Set(options.map((option) => option.value));
    if (
        engineIds.length === 0
        || new Set(engineIds).size !== engineIds.length
        || engineIds.some((engineId) => !available.has(engineId))
    ) {
        return { status: 'refused', reason: 'engineSelectionInvalid' };
    }

    const result = await deps.execute('review.start', {
        sessionId: eligible.sessionId,
        engineIds: [...engineIds],
        instructions: request.instructions,
        changeType: 'committed',
        base: { kind: 'commit', baseCommit: eligible.baseSha },
        scmPullRequestReviewScope: produced.scope,
    });
    return { status: 'started', result };
}
