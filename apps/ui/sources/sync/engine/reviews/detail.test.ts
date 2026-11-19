import { afterEach, describe, expect, it } from 'vitest';
import { observeReviewDetail, refreshReviewDetail } from './detail';
import { getReviewDetailSnapshot, reviewDetailKey } from '@/sync/store/domains/reviews/detail';
import '@/sync/ops/actions/defaultActionExecutor';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ReviewGetRequestV1Schema, type ReviewGetResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(async () => { await homes.reset(); });

function detail(reviewId: string, needsDecision = 0): ReviewGetResponseV1 {
    return {
        review: { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
            counts: { total: 3, needsDecision } },
        human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [],
            needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: needsDecision > 0,
                requestedVerdict: false, pendingDecisions: needsDecision > 0, canSubmitVerdict: false } },
    };
}

describe('demanded Review detail through the real Action and Account transport', () => {
    it('shares reads and stable facts, routes pushes by Review, and rereads after a hidden interval', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-detail.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = { serverId, accountId: 'alice' };
        const key = reviewDetailKey(scope, 'first');
        const reads: string[] = [];
        let needsDecision = 1;
        homes.answer(serverId, 'POST /v1/reviews/get', { select: request => {
            const { reviewId } = ReviewGetRequestV1Schema.parse(request);
            reads.push(reviewId);
            return { body: detail(reviewId, needsDecision) };
        } });
        let release = observeReviewDetail(scope, 'first');
        let releaseOther = observeReviewDetail(scope, 'first');
        try {
            await waitForHomeGovernance(() => expect(getReviewDetailSnapshot(key).status).toBe('ready'));
            expect(reads).toEqual(['first']);
            const before = getReviewDetailSnapshot(key).data;
            await refreshReviewDetail(scope, 'first');
            expect(getReviewDetailSnapshot(key).data).toBe(before);
            const count = reads.length;
            publishHomeAccountChange(serverId, ['some-session'], { changeKinds: ['session'] });
            publishHomeAccountChange(serverId, ['unopened-review'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toHaveLength(count);
            needsDecision = 0;
            publishHomeAccountChange(serverId, ['first'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await waitForHomeGovernance(() => expect(getReviewDetailSnapshot(key).data?.review.counts.needsDecision).toBe(0));
            expect(getReviewDetailSnapshot(key).data?.human.requests).toBe(before?.human.requests);
            release(); release = () => {};
            releaseOther(); releaseOther = () => {};
            const hiddenReads = reads.length;
            needsDecision = 2;
            publishHomeAccountChange(serverId, ['first'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toHaveLength(hiddenReads);
            release = observeReviewDetail(scope, 'first');
            await waitForHomeGovernance(() => expect(getReviewDetailSnapshot(key).data?.review.counts.needsDecision).toBe(2));
        } finally { release(); releaseOther(); }
    });

    it('keeps the captured Account, retains safe detail on transient failure, and withdraws it on refusal', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-detail-failure.example', name: 'Reviews', accountId: 'alice' });
        const otherHome = await homes.addHome({ serverUrl: 'https://reviews-other.example', name: 'Other', accountId: 'bob' });
        await setActiveServerId(otherHome, { scope: 'device' });
        const scope = { serverId, accountId: 'alice' };
        const key = reviewDetailKey(scope, 'safe');
        homes.answer(serverId, 'POST /v1/reviews/get', { body: detail('safe') });
        const release = observeReviewDetail(scope, 'safe');
        try {
            await waitForHomeGovernance(() => expect(getReviewDetailSnapshot(key).status).toBe('ready'));
            const before = getReviewDetailSnapshot(key).data;
            expect(getReviewDetailSnapshot(reviewDetailKey({ serverId: otherHome, accountId: 'bob' }, 'safe')).data).toBeNull();
            homes.answer(serverId, 'POST /v1/reviews/get', { status: 503, body: { error: 'home_temporarily_unavailable' } });
            await refreshReviewDetail(scope, 'safe');
            expect(getReviewDetailSnapshot(key).data).toBe(before);
            expect(getReviewDetailSnapshot(key).error).toMatchObject({ retryable: true, httpStatus: 503 });
            homes.answer(serverId, 'POST /v1/reviews/get', { status: 403, body: { error: 'forbidden' } });
            await refreshReviewDetail(scope, 'safe');
            expect(getReviewDetailSnapshot(key).data).toBeNull();
            expect(getReviewDetailSnapshot(key).error).toMatchObject({ kind: 'forbidden', retryable: false, httpStatus: 403 });
        } finally { release(); }
    });
});
