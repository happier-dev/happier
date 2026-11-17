import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewCommentListRequestV1Schema } from '@happier-dev/protocol/reviews/comments/actions';

import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';

import {
    decideReviewRunFinding,
    loadReviewRunComments,
    readReviewRunComments,
    recordReviewCommentWrites,
    resetReviewRunCommentsForTests,
    subscribeReviewRunComments,
} from './reviewRunComments';

// Only HTTP and stored credentials are substituted: the Action front door, the Home's account
// context, its scoped transport and the review-comment executor run for real.
installApprovalCommonModuleMocks({ storage: (importOriginal) => importOriginal() });
const initialStorageState = getStorage().getState();

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
    await dispose?.();
    dispose = null;
    resetReviewRunCommentsForTests();
    retireActiveServerAccountScopeLifetime();
    invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialStorageState, true);
    vi.restoreAllMocks();
});

function comment(accountId: string, overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        ...buildReviewCommentFixture({ id: 'comment-f1', sessionId: 'sess_1', runId: 'run_1', state: 'proposed', serverRevision: 3 }),
        accountId,
        workspace: { machineId: 'machine-1', path: '/repo' },
        findingId: 'f1',
        ...overrides,
    };
}

/** Home "other" holds the review; Home "focused" is the one the app is looking at. */
async function serveTwoHomes() {
    const served = await serveActionHomes({
        homes: [
            { key: 'other', serverUrl: 'https://review-home-other.test', accountId: 'account-b' },
            { key: 'focused', serverUrl: 'https://review-home-focused.test', accountId: 'account-a' },
        ],
        route: (request) => {
            if (request.path === '/v1/reviews/comments' && request.method === 'GET') {
                return Response.json({ items: [storePlainReviewCommentFixture(comment(request.accountId ?? 'unknown', { body: `from ${request.home}` }))], cursor: null });
            }
            if (request.path.endsWith('/transition')) {
                const body = request.body as { toState: ReviewCommentV1['state']; reviewTriageStatus?: ReviewCommentV1['reviewTriageStatus'] };
                return Response.json({ comment: comment(request.accountId ?? 'unknown', {
                    state: body.toState, reviewTriageStatus: body.reviewTriageStatus, serverRevision: 4,
                }) });
            }
            return undefined;
        },
    });
    dispose = served.dispose;
    return served;
}

describe('review run comments (one cache, bound to its Home and Account)', () => {
    it('retains equal confirmed comments and reloads without hiding a same-revision content change', async () => {
        const target = { scope: { serverId: 'publication-home', accountId: 'account-b' }, sessionId: 'sess_1', runId: 'run_1' };
        const item = comment('account-b');
        const execute = async () => ({ items: [structuredClone(item)], cursor: null });
        await loadReviewRunComments({ ...target, execute });
        const loaded = readReviewRunComments(target);
        const notify = vi.fn();
        const stop = subscribeReviewRunComments(target, notify);
        try {
            recordReviewCommentWrites([structuredClone(item)], target.scope);
            expect(readReviewRunComments(target)).toBe(loaded);
            await loadReviewRunComments({ ...target, execute });
            expect(readReviewRunComments(target)).toBe(loaded);
            expect(notify).not.toHaveBeenCalled();
            recordReviewCommentWrites([{ ...item, body: 'Changed body at the same revision' }], target.scope);
            expect(readReviewRunComments(target).comments[0].body).toBe('Changed body at the same revision');
            expect(notify).toHaveBeenCalledTimes(1);
            recordReviewCommentWrites([{ ...item, serverRevision: item.serverRevision - 1 }], target.scope);
            expect(notify).toHaveBeenCalledTimes(1);
            recordReviewCommentWrites([{ ...item, serverRevision: item.serverRevision + 1 }], target.scope);
            expect(readReviewRunComments(target).comments[0].serverRevision).toBe(item.serverRevision + 1);
            expect(notify).toHaveBeenCalledTimes(2);
        } finally { stop(); }
    });
    it('reads a large review run in as few pages as the list contract allows', async () => {
        const target = { scope: { serverId: 'publication-home', accountId: 'account-b' }, sessionId: 'sess_1', runId: 'run_1' };
        const items = Array.from({ length: 180 }, (_, index) => comment('account-b', { id: `comment-${index}`, findingId: `f${index}` }));
        const pages: number[] = [];
        // The run host pages by the canonical list request (its default page is 50).
        const execute = async (_actionId: string, input: unknown) => {
            const request = ReviewCommentListRequestV1Schema.parse(input);
            const start = request.cursor ? Number(request.cursor) : 0;
            pages.push(start);
            const end = start + request.limit;
            return { items: items.slice(start, end), cursor: end < items.length ? String(end) : null };
        };

        await loadReviewRunComments({ ...target, execute: execute as never });

        expect({ pages: pages.length, comments: readReviewRunComments(target).comments.length }).toEqual({ pages: 1, comments: 180 });
    });

    it('keeps one canonical revision when another reviewer opens an older reference afterwards', async () => {
        let revision = 5;
        const served = await serveActionHomes({
            homes: [{ key: 'home', serverUrl: 'https://review-shared-reference.test', accountId: 'account-b' }],
            route: (request) => {
                if (request.path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
                if (request.path === '/v1/reviews/comments/comment-f1') return Response.json({
                    comment: storePlainReviewCommentFixture(comment('account-b', { runId: 'earlier_round', serverRevision: revision })),
                });
                return undefined;
            },
        });
        dispose = served.dispose;
        const first = { scope: { serverId: served.homes.home!.id, accountId: 'account-b' }, sessionId: 'sess_1', runId: 'run_1', commentIds: ['comment-f1'] };
        await loadReviewRunComments(first);
        revision = 4;
        const second = { ...first, runId: 'run_2' };
        await loadReviewRunComments(second);
        expect(readReviewRunComments(first).comments[0]?.serverRevision).toBe(5);
        expect(readReviewRunComments(second).comments[0]?.serverRevision).toBe(5);
    });

    it('opens a canonical reference requested while the run list is already in flight', async () => {
        let finishList!: (response: Response) => void;
        let listStarted!: () => void;
        const started = new Promise<void>((resolve) => { listStarted = resolve; });
        let reads = 0;
        const served = await serveActionHomes({
            homes: [{ key: 'home', serverUrl: 'https://review-reference.test', accountId: 'account-b' }],
            route: (request) => {
                if (request.path === '/v1/reviews/comments') {
                    if (++reads > 1) return Response.json({ items: [], cursor: null });
                    listStarted();
                    return new Promise<Response>((resolve) => { finishList = resolve; });
                }
                if (request.path === '/v1/reviews/comments/comment-f1') return Response.json({
                    comment: storePlainReviewCommentFixture(comment('account-b', { runId: 'earlier_round' })),
                });
                return undefined;
            },
        });
        dispose = served.dispose;
        const target = { scope: { serverId: served.homes.home!.id, accountId: 'account-b' }, sessionId: 'sess_1', runId: 'run_1' };
        const first = loadReviewRunComments(target);
        await started;
        const referenced = loadReviewRunComments({ ...target, commentIds: ['comment-f1'] });
        finishList(Response.json({ items: [], cursor: null }));
        await Promise.all([first, referenced]);
        expect(readReviewRunComments(target).comments).toEqual([expect.objectContaining({ id: 'comment-f1', runId: 'earlier_round' })]);
    });

    it('keeps a confirmed revision when an older in-flight reload finishes afterwards', async () => {
        let finishReload!: (response: Response) => void;
        let reloadStarted!: () => void;
        const started = new Promise<void>((resolve) => { reloadStarted = resolve; });
        let reads = 0;
        const served = await serveActionHomes({
            homes: [{ key: 'home', serverUrl: 'https://review-reload.test', accountId: 'account-b' }],
            route: (request) => {
                if (request.path !== '/v1/reviews/comments') return undefined;
                if (++reads === 1) return Response.json({ items: [storePlainReviewCommentFixture(comment('account-b'))], cursor: null });
                reloadStarted();
                return new Promise<Response>((resolve) => { finishReload = resolve; });
            },
        });
        dispose = served.dispose;
        const target = { scope: { serverId: served.homes.home!.id, accountId: 'account-b' }, sessionId: 'sess_1', runId: 'run_1' };
        await loadReviewRunComments(target);
        const reloading = loadReviewRunComments(target);
        await started;
        recordReviewCommentWrites([comment('account-b', { state: 'dismissed', reviewTriageStatus: 'reject', serverRevision: 4 })], target.scope);
        finishReload(Response.json({ items: [storePlainReviewCommentFixture(comment('account-b'))], cursor: null }));
        await reloading;
        expect(readReviewRunComments(target).comments[0]).toMatchObject({ state: 'dismissed', reviewTriageStatus: 'reject', serverRevision: 4 });
    });

    it('keeps a confirmed write on its Home when another Home has the same Account and comment ids', async () => {
        const served = await serveActionHomes({
            homes: [
                { key: 'left', serverUrl: 'https://review-left.test', accountId: 'account-b' },
                { key: 'right', serverUrl: 'https://review-right.test', accountId: 'account-b' },
            ],
            route: (request) => {
                if (request.path === '/v1/reviews/comments') return Response.json({ items: [storePlainReviewCommentFixture(comment('account-b'))], cursor: null });
                if (request.path.endsWith('/transition')) return Response.json({ comment: comment('account-b', {
                    state: 'open', reviewTriageStatus: 'accept', serverRevision: 4,
                }) });
                return undefined;
            },
        });
        dispose = served.dispose;
        const left = { scope: { serverId: served.homes.left!.id, accountId: 'account-b' }, sessionId: 'sess_1', runId: 'run_1' };
        const right = { ...left, scope: { ...left.scope, serverId: served.homes.right!.id } };
        await loadReviewRunComments(left);
        await loadReviewRunComments(right);
        expect(await decideReviewRunFinding({ ...left, commentId: 'comment-f1', decision: 'accept' })).toBe(true);
        expect(readReviewRunComments(left).comments[0]?.reviewTriageStatus).toBe('accept');
        expect(readReviewRunComments(right).comments[0]?.serverRevision).toBe(3);
        expect(readReviewRunComments(right).comments[0]?.reviewTriageStatus).toBeUndefined();
    });

    it('reads a review opened from a Home that is not focused from that Home, as its Account', async () => {
        const served = await serveTwoHomes();
        const scope = { serverId: served.homes.other!.id, accountId: 'account-b' };

        await loadReviewRunComments({ scope, sessionId: 'sess_1', runId: 'run_1' });

        expect(served.requests.filter((request) => request.path === '/v1/reviews/comments')).toEqual([
            expect.objectContaining({ home: 'other', accountId: 'account-b' }),
        ]);
        expect(readReviewRunComments({ scope, sessionId: 'sess_1', runId: 'run_1' }).comments)
            .toEqual([expect.objectContaining({ id: 'comment-f1', body: 'from other' })]);
    });

    it('refuses a decision captured under an Account the Home no longer signs in as, and keeps Accounts apart', async () => {
        const served = await serveTwoHomes();
        const before = { serverId: served.homes.other!.id, accountId: 'account-b' };
        await loadReviewRunComments({ scope: before, sessionId: 'sess_1', runId: 'run_1' });

        await served.switchAccount('other', 'account-c');
        const saved = await decideReviewRunFinding({ scope: before, sessionId: 'sess_1', runId: 'run_1', commentId: 'comment-f1', decision: 'accept' });

        expect(saved).toBe(false);
        expect(served.requests.some((request) => request.path.endsWith('/transition'))).toBe(false);
        // The new Account's view starts from its own read, never the previous Account's snapshot.
        const after = { serverId: served.homes.other!.id, accountId: 'account-c' };
        expect(readReviewRunComments({ scope: after, sessionId: 'sess_1', runId: 'run_1' }).status).toBe('idle');
        await loadReviewRunComments({ scope: after, sessionId: 'sess_1', runId: 'run_1' });
        expect(readReviewRunComments({ scope: after, sessionId: 'sess_1', runId: 'run_1' }).comments)
            .toEqual([expect.objectContaining({ accountId: 'account-c' })]);
    });
});
