import { afterEach, describe, expect, it } from 'vitest';
import * as comments from './reviewRunComments';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { computeCanonicalDomainSeparatedKeyedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createReviewCommentsHttpActionExecutor, type ReviewCommentUiActionExecutor } from './api';
import { applyReviewCommentList, createEmptyReviewCommentsState } from './store';
import { selectReviewComments } from './selectors';

const target = { scope: { serverId: 'home', accountId: 'account' }, sessionId: 'session', runId: 'run', reviewId: 'review' };
const finding = (id: string) => buildReviewCommentFixture({ id, reviewId: 'review', sessionId: 'session', runId: 'run' });
afterEach(() => comments.resetReviewRunCommentsForTests());

describe('demanded run comment continuation', () => {
    it('filters decrypted candidate pages without draining them, retains matches on failure, and cancels retired demand', async () => {
        const dataKey = new Uint8Array(32).fill(31);
        const codec = new ArtifactEncryption(dataKey);
        const earlier = buildReviewCommentFixture({ ...finding('earlier'), roundOrdinal: 1, state: 'resolved', body: 'PRIVATE-earlier', transitions: undefined });
        const match = { ...finding('match'), roundOrdinal: 1, body: 'PRIVATE-match' };
        const retired = { ...finding('retired'), roundOrdinal: 1, body: 'PRIVATE-retired' };
        const stored = await Promise.all([earlier, match, retired].map(async value => {
            const plain = storePlainReviewCommentFixture(value);
            if (plain.sensitiveEnvelope.t !== 'plain') throw new Error('Expected logical fixture');
            return { ...plain, sensitiveEnvelope: { t: 'encrypted' as const,
                c: await codec.encryptHeader(plain.sensitiveEnvelope.v as Record<string, unknown>) } };
        }));
        expect(JSON.stringify(stored)).not.toContain('PRIVATE-');
        const requests: { cursor: string | null; signal?: AbortSignal | null }[] = [];
        let continuationFails = true;
        let refreshFails = false;
        let finishRetired!: (response: Response) => void;
        let startedRetired!: () => void;
        const retiredStarted = new Promise<void>(resolve => { startedRetired = resolve; });
        const retiredResponse = new Promise<Response>(resolve => { finishRetired = resolve; });
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json' },
        });
        // HTTP and resource-key acquisition are boundaries. The codec, transport,
        // shared paging owner, store and loaded-results selector all run for real.
        const execute = createReviewCommentsHttpActionExecutor({
            request: async (path, init) => {
                const cursor = new URL(path, 'https://reviews.example').searchParams.get('cursor');
                requests.push({ cursor, signal: init?.signal });
                if (!cursor) return refreshFails ? json({ error: 'offline' }, 503)
                    : json({ items: [stored[0]], cursor: 'next' });
                if (cursor === 'next') {
                    if (continuationFails) { continuationFails = false; return json({ error: 'offline' }, 503); }
                    return json({ items: [stored[1]], cursor: 'retiring' });
                }
                startedRetired();
                return retiredResponse;
            },
            resolveEventStorageContext: async () => { throw new Error('No recipient Account key'); },
            resolveReviewResourceContext: async reviewId => ({ accountId: target.scope.accountId, resource: {
                reviewId, mode: 'e2ee',
                open: async content => content.t === 'encrypted' ? codec.decryptHeaderRaw(content.c) : null,
                seal: async value => ({ t: 'encrypted', c: await codec.encryptHeader(value as Record<string, unknown>) }),
                commitment: (purpose, value) => computeCanonicalDomainSeparatedKeyedDigest(dataKey, 'review-test', [reviewId, purpose, value]),
            } }),
        });
        const loadedMatches = () => {
            const snapshot = comments.readReviewRunComments(target);
            return selectReviewComments(applyReviewCommentList(createEmptyReviewCommentsState(), {
                items: [...snapshot.comments], cursor: snapshot.cursor,
            }), { states: ['open'] });
        };
        const release = comments.subscribeReviewRunComments(target, () => {});
        try {
            await comments.loadReviewRunComments({ ...target, execute });
            expect(loadedMatches()).toEqual([]);
            expect(comments.readReviewRunComments(target).comments).toEqual([earlier]);
            expect(requests.map(request => request.cursor)).toEqual([null]);
            const firstCursor = comments.readReviewRunComments(target).cursor;
            expect(firstCursor).toEqual(expect.any(String));
            await expect(comments.loadMoreReviewRunComments({ ...target, execute })).rejects.toThrow('review_run_comments_unavailable');
            expect(comments.readReviewRunComments(target)).toMatchObject({ cursor: firstCursor, loadMoreFailed: true });
            expect(comments.readReviewRunComments(target).comments).toEqual([earlier]);
            expect(loadedMatches()).toEqual([]);
            await comments.loadMoreReviewRunComments({ ...target, execute });
            expect(loadedMatches()).toEqual([match]);
            expect(requests.map(request => request.cursor)).toEqual([null, 'next', 'next']);
            const retainedCursor = comments.readReviewRunComments(target).cursor;
            refreshFails = true;
            await expect(comments.loadReviewRunComments({ ...target, execute })).rejects.toThrow('review_run_comments_unavailable');
            expect(loadedMatches()).toEqual([match]);
            expect(comments.readReviewRunComments(target)).toMatchObject({ status: 'failed', cursor: retainedCursor });
            const pending = comments.loadMoreReviewRunComments({ ...target, execute });
            await retiredStarted;
            release();
            expect(requests.at(-1)?.signal?.aborted).toBe(true);
            finishRetired(json({ items: [stored[2]], cursor: null }));
            await pending;
            expect(loadedMatches()).toEqual([match]);
            expect(comments.readReviewRunComments(target).comments.map(value => value.id)).toEqual(['earlier', 'match']);
            expect(requests.map(request => request.cursor)).toEqual([null, 'next', 'next', null, 'retiring']);
        } finally { release(); }
    });
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
