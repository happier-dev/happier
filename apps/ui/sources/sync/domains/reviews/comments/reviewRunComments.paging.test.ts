import { afterEach, describe, expect, it } from 'vitest';
import * as comments from './reviewRunComments';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import type { ReviewCommentUiActionExecutor } from './api';

const target = { scope: { serverId: 'home', accountId: 'account' }, sessionId: 'session', runId: 'run', reviewId: 'review' };
const finding = (id: string) => buildReviewCommentFixture({ id, reviewId: 'review', sessionId: 'session', runId: 'run' });
afterEach(() => comments.resetReviewRunCommentsForTests());

describe('demanded run comment continuation', () => {
    it('retains the last good rows with a failed refresh state until explicit recovery', async () => {
        const root = finding('retained');
        let offline = false;
        const execute: ReviewCommentUiActionExecutor = async () => {
            if (offline) throw new Error('offline');
            return { items: [root], cursor: null };
        };
        await comments.loadReviewRunComments({ ...target, execute });
        offline = true;
        await expect(comments.loadReviewRunComments({ ...target, execute })).rejects.toThrow();
        expect(comments.readReviewRunComments(target)).toMatchObject({ status: 'failed', comments: [{ id: root.id }] });
        offline = false;
        await comments.loadReviewRunComments({ ...target, execute });
        expect(comments.readReviewRunComments(target)).toMatchObject({ status: 'loaded', comments: [{ id: root.id }] });
    });
    it('loads a detached Review once and shares confirmed decisions with its loaded run', async () => {
        const aggregate = { scope: target.scope, reviewId: target.reviewId };
        const root = finding('first');
        const requests: unknown[] = [];
        const execute: ReviewCommentUiActionExecutor = async (id, input) => {
            requests.push({ id, input });
            if (id === 'reviews.comments.transition') return { comment: { ...root, serverRevision: 2, state: 'dismissed', reviewTriageStatus: 'reject' } };
            if (input && typeof input === 'object' && 'runId' in input && input.runId) return { items: [root], cursor: null };
            expect(input).not.toHaveProperty('sessionId');
            expect(input).not.toHaveProperty('runId');
            return { items: [root, { ...finding('second'), runId: 'another-run' }], cursor: 'next' };
        };
        await comments.loadReviewRunComments({ ...target, execute });
        await comments.loadReviewRunComments({ ...aggregate, execute });
        await comments.ensureReviewRunComments({ ...aggregate, execute });
        expect(requests).toHaveLength(2);
        expect(comments.readReviewRunComments(aggregate).comments.map(item => item.id)).toEqual(['first', 'second']);
        expect(await comments.decideReviewRunFinding({ ...aggregate, commentId: root.id, decision: 'reject', execute })).toBe(true);
        expect(comments.readReviewRunComments(target).comments[0]?.reviewTriageStatus).toBe('reject');
    });
    it('reads one candidate page per explicit request and retains rows/cursor for retry', async () => {
        const cursors: unknown[] = [];
        let failed = false;
        const execute: ReviewCommentUiActionExecutor = async (_id, input) => {
            const cursor = (input as { cursor?: string }).cursor;
            cursors.push(cursor);
            if (!cursor) return { items: [finding('first')], cursor: 'next' };
            if (!failed) { failed = true; throw new Error('offline'); }
            return { items: [finding('second')], cursor: null };
        };
        await comments.loadReviewRunComments({ ...target, execute });
        expect(cursors).toEqual([undefined]);
        expect(comments.readReviewRunComments(target)).toMatchObject({ cursor: 'next', comments: [{ id: 'first' }] });
        await expect(comments.loadMoreReviewRunComments({ ...target, execute })).rejects.toThrow();
        expect(comments.readReviewRunComments(target)).toMatchObject({ cursor: 'next', comments: [{ id: 'first' }], loadMoreFailed: true });
        await comments.loadMoreReviewRunComments({ ...target, execute });
        expect(comments.readReviewRunComments(target)).toMatchObject({ cursor: null, comments: [{ id: 'first' }, { id: 'second' }] });
        expect(cursors).toEqual([undefined, 'next', 'next']);
    });
});
