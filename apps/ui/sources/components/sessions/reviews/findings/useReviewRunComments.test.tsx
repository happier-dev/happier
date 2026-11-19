import { afterEach, expect, it } from 'vitest';

import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { loadMoreReviewRunComments, loadReviewRunComments, recordReviewCommentWrites, resetReviewRunCommentsForTests } from '@/sync/domains/reviews/comments/reviewRunComments';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

import { useReviewComments, useReviewRunsComments } from './useReviewRunComments';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await import('@/sync/ops/actions/defaultActionExecutor');

afterEach(async () => {
    await standardCleanup();
    resetReviewRunCommentsForTests();
    await homes.reset();
});

it('follows mounted native Review revisions, retains rows on failed reads, and refreshes explicitly', async () => {
    const accountId = 'review-reader';
    const serverId = await homes.addHome({ name: 'Review Home', serverUrl: 'https://mounted-review.example', accountId, currentAccount: true });
    const reviewId = 'mounted-review';
    const target = { scope: { serverId, accountId }, reviewId };
    // The Home's Artifact and HTTP ports are boundaries; opening the resource,
    // Action dispatch, comment codec, observer and mounted hook remain real.
    const created = await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
        id: reviewId, kind: deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 }),
        header: encodePlainArtifactStoredContent({ v: 1, kind: REVIEW_ARTIFACT_KIND_V1, reviewId, title: 'Mounted Review' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, rounds: [] }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    expect(created?.status).toBe(200);
    let current = buildReviewCommentFixture({ id: 'mounted-root', reviewId, accountId, runId: 'mounted-run', body: 'Last good body' });
    let offline = false;
    const listPath = '/v1/reviews/comments';
    const getPath = `${listPath}/${current.id}`;
    homes.answer(serverId, `GET ${listPath}`, { select: () => ({ body: { items: [storePlainReviewCommentFixture(current)], cursor: null } }) });
    homes.answer(serverId, `GET ${getPath}`, { select: () => offline
        ? { status: 503, body: { error: 'offline' } }
        : { body: { comment: storePlainReviewCommentFixture(current) } } });
    const wake = (revision: number) => publishHomeAccountChange(serverId, [reviewId], { changeKinds: ['artifact'],
        reviewCommentChanges: [{ reviewId, commentId: current.id, serverRevision: revision, state: 'open' }] });
    const hook = await renderHook(() => useReviewComments({ ...target, enabled: true }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'loaded', comments: [{ body: 'Last good body' }] }));
        current = { ...current, serverRevision: 2, bodyVersion: 2, body: 'Remote edit' };
        await act(async () => wake(2));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'loaded', comments: [{ serverRevision: 2, body: 'Remote edit' }] }));
        offline = true;
        await act(async () => wake(3));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ status: 'failed', comments: [{ serverRevision: 2, body: 'Remote edit' }] }));
        offline = false;
        current = { ...current, serverRevision: 3, bodyVersion: 3, body: 'Recovered body' };
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'loaded', comments: [{ serverRevision: 3, body: 'Recovered body' }] });
        await hook.unmount();
        const readsAfterUnmount = homes.requestsFor(getPath).length;
        wake(4);
        await flushHookEffects();
        expect(homes.requestsFor(getPath)).toHaveLength(readsAfterUnmount);
    } finally { await hook.unmount(); }
});

it('reuses the demanded Review window and follows confirmed writes while mounted', async () => {
    const target = { scope: { serverId: 'review-home', accountId: 'reader' }, reviewId: 'review-1' };
    const comment = buildReviewCommentFixture({ id: 'root', reviewId: target.reviewId, accountId: 'author', runId: 'run-1' });
    let reads = 0;
    await loadReviewRunComments({ ...target, execute: async () => {
        reads += 1;
        return { items: [comment], cursor: 'next' };
    } });
    const hook = await renderHook(() => useReviewComments({ ...target, enabled: true }));
    expect(hook.getCurrent()).toMatchObject({ status: 'loaded', cursor: 'next', comments: [{ id: comment.id }] });
    await act(async () => recordReviewCommentWrites([{ ...comment, serverRevision: 2, reviewTriageStatus: 'reject' }], target.scope));
    expect(hook.getCurrent().comments[0]?.reviewTriageStatus).toBe('reject');
    expect(reads).toBe(1);
    await hook.unmount();
});

it('exposes explicit per-run continuation and shares a pending page with other readers', async () => {
    const target = { scope: { serverId: 'run-home', accountId: 'reader' }, sessionId: 'session', reviewId: 'review-2', runId: 'run-2' };
    const first = buildReviewCommentFixture({ id: 'first', reviewId: target.reviewId, runId: target.runId });
    const second = { ...first, id: 'second' };
    await loadReviewRunComments({ ...target, execute: async () => ({ items: [first], cursor: 'next' }) });
    await loadReviewRunComments({ ...target, runId: 'unchanged-run', execute: async () => ({ items: [], cursor: null }) });
    const hook = await renderHook(() => useReviewRunsComments({ scope: target.scope, sessionId: target.sessionId,
        runIds: [target.runId, 'unchanged-run'], reviewIdsByRunId: { [target.runId]: target.reviewId, 'unchanged-run': target.reviewId }, enabled: true }));
    const unchangedRun = hook.getCurrent()[1];
    let finishPage!: (page: { items: typeof first[]; cursor: null }) => void;
    const page = new Promise<{ items: typeof first[]; cursor: null }>(resolve => { finishPage = resolve; });
    let ownerRead!: Promise<void>;
    await act(async () => { ownerRead = loadMoreReviewRunComments({ ...target, execute: async () => page }); });
    let continuation!: Promise<void>;
    let settled = false;
    await act(async () => {
        continuation = hook.getCurrent()[0]!.loadMore().then(() => { settled = true; });
        await Promise.resolve();
    });
    expect(settled).toBe(false);
    expect(hook.getCurrent()[0]).toMatchObject({ cursor: 'next', loadingMore: true });
    await act(async () => {
        finishPage({ items: [second], cursor: null });
        await Promise.all([ownerRead, continuation]);
    });
    expect(hook.getCurrent()[0]).toMatchObject({ cursor: null, loadingMore: false, comments: [{ id: first.id }, { id: second.id }] });
    expect(hook.getCurrent()[1]).toBe(unchangedRun);
    await hook.unmount();
});
