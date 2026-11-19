import { afterEach, describe, expect, it } from 'vitest';
import { observeReviewDetail, refreshReviewDetail } from './detail';
import { getReviewDetailSnapshot, reviewDetailKey } from '@/sync/store/domains/reviews/detail';
import '@/sync/ops/actions/defaultActionExecutor';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ReviewGetRequestV1Schema, type ReviewGetResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';

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
    it('shares the Review owner with a live plugin Resource, explicit refresh, scoped pushes and refusal', async () => {
        const { createPluginReviewDetailHostReadStore } = await import('@/components/plugins/surfaces/pluginReviewDetailHostRead');
        const serverId = await homes.addHome({ serverUrl: 'https://review-resource.example', name: 'Review Resource', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const account = await resolveServerCredentialAccountScope(serverId);
        if (account.kind !== 'bound') throw new Error('Missing captured Review Account');
        const lifetime = captureServerCredentialAccountScopeLifetime(account);
        let needsDecision = 1;
        let reads = 0;
        homes.answer(serverId, 'POST /v1/reviews/get', { select: request => {
            const { reviewId } = ReviewGetRequestV1Schema.parse(request);
            reads += 1;
            return { body: detail(reviewId, needsDecision) };
        } });
        const store = createPluginReviewDetailHostReadStore({ lifetime });
        const entry = store.getEntry({ hostRead: 'review.get', input: { reviewId: 'selected' } });
        const selected = entry.select({ decode: (content: { bytes: Uint8Array }) => JSON.parse(new TextDecoder().decode(content.bytes)) as ReviewGetResponseV1 }, value => value);
        const releaseNative = observeReviewDetail(lifetime.scope, 'selected');
        let release = selected.subscribe(() => {}, true);
        try {
            await waitForHomeGovernance(() => expect(selected.getSnapshot().value?.review.counts.needsDecision).toBe(1));
            expect(reads).toBe(1);
            needsDecision = 2;
            await selected.refresh();
            expect(selected.getSnapshot().value?.review.counts.needsDecision).toBe(2);
            expect(reads).toBe(2);
            publishHomeAccountChange(serverId, ['unrelated'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(2);
            needsDecision = 0;
            publishHomeAccountChange(serverId, ['selected'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await waitForHomeGovernance(() => expect(selected.getSnapshot().value?.human.needsYou.needsYou).toBe(false));
            expect(reads).toBe(3);
            homes.answer(serverId, 'POST /v1/reviews/get', { status: 403, body: { error: 'forbidden' } });
            await selected.refresh();
            expect(selected.getSnapshot().value).toBeUndefined();
            expect(selected.getSnapshot().error).toMatchObject({ code: 'permission_denied', retryable: false });
            release(); release = () => {};
            releaseNative();
            const hiddenReads = reads;
            publishHomeAccountChange(serverId, ['selected'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(hiddenReads);
        } finally { release(); releaseNative(); store.dispose(); }
    });
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
