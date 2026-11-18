import { afterEach, describe, expect, it } from 'vitest';
import '@/sync/ops/actions/defaultActionExecutor';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ReviewListItemV1, ReviewListRequestV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getReviewListSnapshot, reviewListKey } from '@/sync/store/domains/reviews/list';
import { loadMoreReviews, observeReviewList, refreshReviewList } from './list';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(async () => { await homes.reset(); });
const input: ReviewListRequestV1 = { limit: 2 };
function row(reviewId: string): ReviewListItemV1 {
    return { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
        state: 'running', currentRoundOrdinal: 1, startedAt: 1, finishedAt: null, createdAt: 1, updatedAt: 1,
        counts: { total: 0, needsDecision: 0 } };
}

describe('demanded Review list through the real Action and Account transport', () => {
    it('shares one visible read, continues explicitly, ignores unrelated pushes, and recovers current headers on return', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-list.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = { serverId, accountId: 'alice' };
        const key = reviewListKey(scope, input);
        const requests: ReviewListRequestV1[] = [];
        let state: ReviewListItemV1['state'] = 'running';
        homes.answer(serverId, 'POST /v1/reviews/list', { select: request => {
            const parsed = request as ReviewListRequestV1;
            requests.push(parsed);
            return { body: { items: [{ ...row(parsed.cursor ? 'second' : 'first'), state }],
                cursor: parsed.cursor ? null : 'opaque:next' } };
        } });
        let release = observeReviewList(scope, input);
        let releaseOther = observeReviewList(scope, input);
        try {
            await waitForHomeGovernance(() => expect(getReviewListSnapshot(key).status).toBe('ready'));
            expect(requests).toEqual([input]);
            await Promise.all([loadMoreReviews(scope, input), loadMoreReviews(scope, input)]);
            expect(requests).toEqual([input, { ...input, cursor: 'opaque:next' }]);
            expect(getReviewListSnapshot(key).items?.map(item => item.reviewId)).toEqual(['first', 'second']);
            const reads = requests.length;
            for (let i = 0; i < 20; i++) publishHomeAccountChange(serverId, [`session-${i}`], { changeKinds: ['session'] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(requests).toHaveLength(reads);
            state = 'completed';
            publishHomeAccountChange(serverId, ['first'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await waitForHomeGovernance(() => expect(getReviewListSnapshot(key).items?.[0]?.state).toBe('completed'));
            expect(requests).toHaveLength(reads + 1);
            release(); release = () => {};
            releaseOther(); releaseOther = () => {};
            state = 'failed';
            const hiddenReads = requests.length;
            publishHomeAccountChange(serverId, ['first'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(requests).toHaveLength(hiddenReads);
            release = observeReviewList(scope, input);
            await waitForHomeGovernance(() => expect(getReviewListSnapshot(key).items?.[0]?.state).toBe('failed'));
        } finally { release(); releaseOther(); }
    });

    it('retains safe rows on a failed refresh and carries the transport classification', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://reviews-list-failure.example', name: 'Reviews', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = { serverId, accountId: 'alice' };
        const key = reviewListKey(scope, input);
        homes.answer(serverId, 'POST /v1/reviews/list', { body: { items: [row('safe')], cursor: null } });
        const release = observeReviewList(scope, input);
        try {
            await waitForHomeGovernance(() => expect(getReviewListSnapshot(key).status).toBe('ready'));
            const before = getReviewListSnapshot(key).items;
            homes.answer(serverId, 'POST /v1/reviews/list', { status: 503, body: { error: 'home_temporarily_unavailable' } });
            await refreshReviewList(scope, input);
            expect(getReviewListSnapshot(key).items).toBe(before);
            expect(getReviewListSnapshot(key).error).toMatchObject({ kind: 'unknown', retryable: true, code: null, httpStatus: 503 });
        } finally { release(); }
    });
});
