import { observeReviewCommentChanges } from './commentChanges';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { loadReviewRunComments, readReviewRunComments, resetReviewRunCommentsForTests } from './reviewRunComments';
const comment = (accountId: string, overrides: Partial<ReviewCommentV1> = {}) => buildReviewCommentFixture({ id: 'finding', accountId,
    sessionId: 'sess_1', runId: 'run_1', serverRevision: 3, ...overrides });
afterEach(() => resetReviewRunCommentsForTests());
it('surfaces a targeted read failure without discarding retained comments', async () => {
    const scope = { serverId: 'failed-review-home', accountId: 'reader' };
    const target = { scope, sessionId: 'session', runId: 'run', reviewId: 'failed-review' };
    const held = comment('author', { reviewId: target.reviewId });
    await loadReviewRunComments({ ...target, execute: async () => ({ items: [held], cursor: null }) });
    const failed = vi.fn();
    const release = observeReviewCommentChanges({ ...target,
        readComments: () => readReviewRunComments(target).comments,
        execute: async () => { throw new Error('offline'); },
        reload: async () => { throw new Error('unexpected list reload'); }, onReadFailed: failed });
    try {
        publishHomeAccountChange(scope.serverId, [target.reviewId], { changeKinds: ['artifact'],
            reviewCommentChanges: [{ reviewId: target.reviewId, commentId: held.id, serverRevision: 4, state: 'dismissed' }] });
        await vi.waitFor(() => expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'offline' })));
        expect(readReviewRunComments(target).comments).toEqual([held]);
    } finally { release(); }
});
    it('refreshes a remotely changed finding once for all mounted readers and ignores held revisions and other Reviews', async () => {
        let current = comment('account-b', { reviewId: 'review-a' });
        let finishRead!: () => void;
        const heldRead = new Promise<void>(resolve => { finishRead = resolve; });
        const reads: string[] = [];
        const execute = async (_action: string, input: unknown) => {
            expect(input).toMatchObject({ reviewId: 'review-a' });
            reads.push((input as { commentId: string }).commentId);
            await heldRead;
            return { comment: current };
        };
        const scope = { serverId: 'review-home', accountId: 'account-b' };
        const target = { scope, sessionId: 'sess_1', runId: 'run_1', reviewId: 'review-a' };
        await loadReviewRunComments({ ...target, execute: async () => ({ items: [current], cursor: null }) });
        const observe = () => observeReviewCommentChanges({ scope, execute,
            readComments: () => readReviewRunComments(target).comments, reload: async () => { throw new Error('unexpected broad reload'); } });
        const releases = [observe(), observe()];
        const wake = (reviewId: string, revision: number) => publishHomeAccountChange(scope.serverId, [reviewId], {
            changeKinds: ['artifact'], reviewCommentChanges: [{ reviewId, commentId: current.id,
                serverRevision: revision, state: 'dismissed', reviewTriageStatus: 'reject' }],
        });
        try {
            wake('review-b', 4);
            wake('review-a', 3);
            expect(reads).toEqual([]);
            current = { ...current, state: 'dismissed', reviewTriageStatus: 'reject', serverRevision: 4 };
            wake('review-a', 4);
            await vi.waitFor(() => expect(reads).toEqual([current.id]));
            finishRead();
            await vi.waitFor(() => expect(readReviewRunComments(target).comments[0]?.reviewTriageStatus).toBe('reject'));
            wake('review-a', 4);
            expect(reads).toEqual([current.id]);
        } finally { releases.forEach(release => release()); }
        wake('review-a', 5);
        expect(reads).toEqual([current.id]);
    });


it('refreshes new appearances at the same decision revision for every mounted reader', async () => {
    const scope = { serverId: 'appearance-home', accountId: 'reader' };
    const target = { scope, reviewId: 'appearance-review' };
    const held = comment('author', { reviewId: target.reviewId });
    const updated = comment('author', { reviewId: target.reviewId,
        appearances: [{ roundOrdinal: 2, runId: 'later-run', reviewerId: 'reviewer' }] });
    await loadReviewRunComments({ ...target, execute: async () => ({ items: [held], cursor: null }) });
    const reads = vi.fn(async () => ({ comment: updated }));
    const reload = vi.fn(async () => undefined);
    const observe = () => observeReviewCommentChanges({ ...target, execute: reads,
        readComments: () => readReviewRunComments(target).comments, reload });
    const releases = [observe(), observe()];
    try {
        publishHomeAccountChange(scope.serverId, [target.reviewId], { changeKinds: ['artifact'],
            reviewCommentChanges: [{ reviewId: target.reviewId, commentId: held.id,
                serverRevision: held.serverRevision, state: held.state, appearanceCount: updated.appearances!.length }] });
        await vi.waitFor(() => expect(readReviewRunComments(target).comments[0]?.appearances).toEqual(updated.appearances));
        expect(reads).toHaveBeenCalledTimes(1);
        publishHomeAccountChange(scope.serverId, [target.reviewId], { changeKinds: ['artifact'],
            reviewCommentChanges: [{ reviewId: target.reviewId, commentId: held.id,
                serverRevision: held.serverRevision, state: held.state, appearanceCount: updated.appearances!.length }] });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(reads).toHaveBeenCalledTimes(1);
        expect(reload).not.toHaveBeenCalled();
    } finally { releases.forEach(release => release()); }
});

it('reads the later appearance when its push arrives during an earlier targeted response', async () => {
    const scope = { serverId: 'appearance-burst-home', accountId: 'reader' };
    const target = { scope, reviewId: 'appearance-burst-review' };
    const held = comment('author', { reviewId: target.reviewId });
    const first = comment('author', { reviewId: target.reviewId,
        appearances: [{ roundOrdinal: 1, runId: 'first', reviewerId: 'reviewer' }] });
    const latest = comment('author', { reviewId: target.reviewId,
        appearances: [...first.appearances!, { roundOrdinal: 2, runId: 'second', reviewerId: 'reviewer' }] });
    await loadReviewRunComments({ ...target, execute: async () => ({ items: [held], cursor: null }) });
    let completeFirst!: () => void;
    const firstResponse = new Promise<void>(resolve => { completeFirst = resolve; });
    const reads = vi.fn(async () => ({ comment: latest }));
    reads.mockImplementationOnce(async () => { await firstResponse; return { comment: first }; });
    const release = observeReviewCommentChanges({ ...target, execute: reads,
        readComments: () => readReviewRunComments(target).comments,
        reload: async () => { throw new Error('unexpected broad reload'); } });
    const wake = (appearanceCount: number) => publishHomeAccountChange(scope.serverId, [target.reviewId], { changeKinds: ['artifact'],
        reviewCommentChanges: [{ reviewId: target.reviewId, commentId: held.id,
            serverRevision: held.serverRevision, state: held.state, appearanceCount }] });
    try {
        wake(1);
        await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
        wake(2);
        completeFirst();
        await vi.waitFor(() => expect(readReviewRunComments(target).comments[0]?.appearances).toEqual(latest.appearances));
        expect(reads).toHaveBeenCalledTimes(2);
    } finally { completeFirst(); release(); }
});
