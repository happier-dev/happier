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
import { createPlainArtifactHttpFixture, projectArtifactBoundaryReadRow } from '@/dev/testkit/harness/artifactStoreBoundary';
import { observeReviewList } from './list';
import { getReviewListSnapshot, reviewListKey } from '@/sync/store/domains/reviews/list';

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
    it('coalesces a comment burst for two mounted detail and list readers into one read plus one trailing read', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://review-comment-burst.example', name: 'Review burst', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = { serverId, accountId: 'alice' };
        const input = { limit: 2 };
        const counts = { detail: 0, list: 0 };
        let needsDecision = 3;
        let held: Promise<void> = Promise.resolve();
        homes.answer(serverId, 'POST /v1/reviews/get', { select: async () => {
            counts.detail += 1;
            const body = detail('selected', needsDecision);
            await held;
            return { body };
        } });
        homes.answer(serverId, 'POST /v1/reviews/list', { select: async () => {
            counts.list += 1;
            const value = detail('selected', needsDecision);
            const body = { items: [{ ...value.review, needsYou: value.human.needsYou }], cursor: null };
            await held;
            return { body };
        } });
        const releases = [observeReviewDetail(scope, 'selected'), observeReviewDetail(scope, 'selected'),
            observeReviewList(scope, input), observeReviewList(scope, input)];
        let finishRead = () => {};
        try {
            await waitForHomeGovernance(() => {
                expect(getReviewDetailSnapshot(reviewDetailKey(scope, 'selected')).status).toBe('ready');
                expect(getReviewListSnapshot(reviewListKey(scope, input)).status).toBe('ready');
            });
            expect(counts).toEqual({ detail: 1, list: 1 });
            held = new Promise<void>(resolve => { finishRead = resolve; });
            const wake = (revision: number) => publishHomeAccountChange(serverId, ['selected'], {
                changeKinds: ['artifact'], feedPageConsumed: true,
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })],
                reviewCommentChanges: [{ reviewId: 'selected', commentId: 'finding', serverRevision: revision, state: 'open' }],
            });
            wake(2);
            await waitForHomeGovernance(() => expect(counts).toEqual({ detail: 2, list: 2 }));
            needsDecision = 0;
            for (let revision = 3; revision <= 22; revision += 1) wake(revision);
            expect(counts).toEqual({ detail: 2, list: 2 });
            finishRead();
            await waitForHomeGovernance(() => {
                expect(getReviewDetailSnapshot(reviewDetailKey(scope, 'selected')).data?.review.counts.needsDecision).toBe(0);
                expect(getReviewListSnapshot(reviewListKey(scope, input)).items?.[0]?.counts.needsDecision).toBe(0);
            });
            expect(counts).toEqual({ detail: 3, list: 3 });
        } finally { finishRead(); releases.forEach(release => release()); }
    });

    it('opens the Review record only while a consumer demands it, sharing metadata with the summary', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://review-record.example', name: 'Review record', accountId: 'alice' });
        await setActiveServerId(serverId, { scope: 'device' });
        const scope = { serverId, accountId: 'alice' };
        const key = reviewDetailKey(scope, 'record');
        let reads = 0;
        homes.answer(serverId, 'POST /v1/reviews/get', { select: () => {
            reads += 1;
            return { body: detail('record') };
        } });
        const artifact = createPlainArtifactHttpFixture({
            id: 'record', title: 'Code review · Changes',
            header: { kind: 'review.v1', v: 1, reviewId: 'record', title: 'Code review · Changes' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
                reviewerIds: [], runs: [{ kind: 'workflow', runId: 'original-run' }] }] }),
            ownerAccountId: 'alice', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 2,
        }, 'alice');
        homes.artifacts(serverId).replaceStoredRow(artifact);
        const bundledPath = '/v1/reviews/get?includeContentArtifact=true';
        homes.answer(serverId, `POST ${bundledPath}`, { select: input => {
            expect(input).toEqual({ reviewId: 'record' });
            reads += 1;
            return { body: { ...detail('record'), contentArtifact: projectArtifactBoundaryReadRow(artifact) } };
        } });
        const summary = observeReviewDetail(scope, 'record');
        await waitForHomeGovernance(() => expect(getReviewDetailSnapshot(key).status).toBe('ready'));
        expect(getReviewDetailSnapshot(key).data).not.toHaveProperty('record');
        const requestStart = homes.requests.length;
        const startedAt = performance.now();
        const workflow = observeReviewDetail(scope, 'record', { includeRecord: true });
        try {
            await waitForHomeGovernance(() => expect(getReviewDetailSnapshot(key).data).toHaveProperty('record.title', 'Code review · Changes'));
            const paths = homes.requests.slice(requestStart).map(request => request.path)
                .filter(path => path.startsWith('/v1/reviews/get') || path === '/v1/artifacts/record');
            if (process.env.HAPPIER_P03_JOURNEY_COST === '1') {
                console.info('P03_REVIEW_DETAIL_COST', JSON.stringify({ paths, elapsedMs: performance.now() - startedAt }));
            }
            expect(paths).toEqual([bundledPath]);
            expect(reads).toBe(2);
            const other = observeReviewDetail(scope, 'record', { includeRecord: true });
            other();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(2);
            const account = await resolveServerCredentialAccountScope(serverId);
            if (account.kind !== 'bound') throw new Error('Missing captured Review Account');
            const { createPluginReviewDetailHostReadStore } = await import('@/components/plugins/surfaces/pluginReviewDetailHostRead');
            const store = createPluginReviewDetailHostReadStore({ lifetime: captureServerCredentialAccountScopeLifetime(account) });
            const resource = store.getEntry({ hostRead: 'review.get', input: { reviewId: 'record' } }).select({
                decode: (content: { bytes: Uint8Array }): unknown => JSON.parse(new TextDecoder().decode(content.bytes)),
            }, value => value);
            const release = resource.subscribe(() => {}, true);
            try {
                // The Resource's published fields stay metadata/person state; opened history belongs to native detail.
                await waitForHomeGovernance(() => expect(resource.getSnapshot().value).toEqual(detail('record')));
            } finally { release(); store.dispose(); }
            // An older Home ignores the query hint and returns the metadata shape.
            homes.answer(serverId, `POST ${bundledPath}`, { body: detail('record') });
            const fallbackStart = homes.requests.length;
            await refreshReviewDetail(scope, 'record');
            expect(getReviewDetailSnapshot(key).data?.record?.title).toBe('Code review · Changes');
            expect(homes.requests.slice(fallbackStart).map(request => request.path))
                .toEqual(expect.arrayContaining([bundledPath, '/v1/artifacts/record']));
        } finally { workflow(); summary(); }
    });
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
