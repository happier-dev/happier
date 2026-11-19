import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewCommentTransitionRequestV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { buildReviewCommentFixture, flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { commitPreferredLanguage, getPreferredLanguage } from '@/text/preferredLanguage';

import {
    decideReviewRunFinding,
    loadReviewRunComments,
    readReviewRunComments,
    resetReviewRunCommentsForTests,
    recordReviewCommentWrites,
} from '@/sync/domains/reviews/comments/reviewRunComments';

import { ReviewCommentsSessionSurface } from './ReviewCommentsSessionSurface';

// The native recycler is the physical layout boundary; list/card behavior stays real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});
// The popover's portal and window measurement are the boundary; the real More menu and its rows render inline.
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { getPreferredLanguage } = await import('@/text/preferredLanguage');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => {
        if (getPreferredLanguage() === 'fr') return `fr:${key}`;
        if (key === 'files.reviewComments.durable.count') return String(params?.count ?? '');
        if (key === 'files.reviewComments.durable.bulkFailure') return `${String(params?.commentId ?? '')}:${String(params?.errorCode ?? '')}`;
        return key;
    } });
});

const modalMock = vi.hoisted(() => ({
    prompt: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: modalMock.prompt,
        },
    }).module;
});

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return buildReviewCommentFixture({ body: 'body', ...overrides });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

/** A menu opens and selects on the next frame (its own scheduling, with a timer fallback); wait it out. */
const settleMenu = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });

describe('ReviewCommentsSessionSurface', () => {
    it('reaches comments after the first hundred only on explicit continuation and cancels retired scope demand', async () => {
        const pending = deferred<{ items: ReviewCommentV1[]; cursor: null }>();
        const onUnresolvedCountChange = vi.fn();
        const requests: { input: unknown; signal?: AbortSignal }[] = [];
        const execute = vi.fn(async (_action: ActionId, input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
            requests.push({ input, signal: options?.signal });
            const query = input as { projectId?: string; cursor?: string };
            if (query.projectId === 'project-2') return { items: [comment({ id: 'new-scope', projectId: 'project-2' })], cursor: null };
            if (query.cursor === 'page-3') return pending.promise;
            if (query.cursor === 'page-2') return { items: [comment({ id: 'later-page' })], cursor: 'page-3' };
            return { items: Array.from({ length: 100 }, (_, index) => comment({ id: `first-${index}` })), cursor: 'page-2' };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} onUnresolvedCountChange={onUnresolvedCountChange} testID="comments" />);
        await flushHookEffects();
        expect(requests).toHaveLength(1);
        expect(screen.findByTestId('comments-load-more')).not.toBeNull();
        expect(onUnresolvedCountChange).toHaveBeenLastCalledWith(null);
        await screen.pressByTestIdAsync('comments-load-more');
        expect(requests).toHaveLength(2);
        expect(screen.findHostByTestId('review-comment-later-page')).not.toBeNull();
        expect(screen.findHostByTestId('review-comment-first-0')).not.toBeNull();
        await act(async () => { screen.findByTestId('comments-load-more')?.props.onPress(); });
        expect(requests).toHaveLength(3);
        await screen.update(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-2" execute={execute} onUnresolvedCountChange={onUnresolvedCountChange} testID="comments" />);
        await flushHookEffects();
        expect(requests[2]?.signal?.aborted).toBe(true);
        await act(async () => { pending.resolve({ items: [comment({ id: 'retired-scope' })], cursor: null }); });
        expect(screen.findHostByTestId('review-comment-new-scope')).not.toBeNull();
        expect(screen.findHostByTestId('review-comment-retired-scope')).toBeNull();
        expect(onUnresolvedCountChange).toHaveBeenLastCalledWith(1);
    });

    it('keeps empty candidate continuation available after failure and retries the same page', async () => {
        let continuationAttempts = 0;
        const execute = vi.fn(async (_action: ActionId, input: unknown) => {
            if (!(input as { cursor?: string }).cursor) return { items: [], cursor: 'page-2' };
            continuationAttempts += 1;
            if (continuationAttempts === 1) throw new Error('offline');
            return { items: [comment({ id: 'after-empty-page' })], cursor: null };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} testID="comments" />);
        await flushHookEffects();
        await screen.pressByTestIdAsync('comments-load-more');
        expect(screen.findByTestId('comments-load-more')).not.toBeNull();
        expect(screen.getTextContent()).toContain('files.reviewComments.durable.loadFailed');
        await screen.pressByTestIdAsync('comments-load-more');
        expect(continuationAttempts).toBe(2);
        expect(screen.findHostByTestId('review-comment-after-empty-page')).not.toBeNull();
        expect(screen.findByTestId('comments-load-more')).toBeNull();
    });

    it('retains demanded pages when reporting the final count rerenders the same workspace host', async () => {
        const execute = vi.fn(async (_action: ActionId, input: unknown) => (
            (input as { cursor?: string }).cursor
                ? { items: [comment({ id: 'later-page' })], cursor: null }
                : { items: [comment({ id: 'first-page' })], cursor: 'next' }
        ));
        function WorkspaceHost() {
            const [, setCount] = React.useState<number | null>(null);
            return <ReviewCommentsSessionSurface scope={RUN.scope} workspace={{ machineId: 'machine', path: '/repo' }}
                execute={execute} onUnresolvedCountChange={setCount} testID="comments" />;
        }
        const screen = await renderScreen(<WorkspaceHost />);
        await flushHookEffects();
        await screen.pressByTestIdAsync('comments-load-more');
        await flushHookEffects();
        expect(screen.findHostByTestId('review-comment-later-page')).not.toBeNull();
        expect(screen.findHostByTestId('review-comment-first-page')).not.toBeNull();
        expect(screen.findByTestId('comments-load-more')).toBeNull();
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it('refreshes a comment window after its last placement closes and reopens', async () => {
        let current = comment({ body: 'Before closing' });
        const execute = vi.fn(async () => ({ items: [current], cursor: null }));
        const surface = (open: boolean) => <ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1"
            header="external" open={open} execute={execute} />;
        const screen = await renderScreen(surface(true));
        await flushHookEffects();
        await screen.update(surface(false));
        current = comment({ body: 'Written while closed', serverRevision: 2 });
        await screen.update(surface(true));
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Written while closed');
        expect(execute).toHaveBeenCalledTimes(2);
    });

    let initialLanguage: ReturnType<typeof getPreferredLanguage>;
    beforeEach(() => {
        initialLanguage = getPreferredLanguage();
        commitPreferredLanguage('en');
        modalMock.prompt.mockReset();
        resetReviewRunCommentsForTests();
    });
    afterEach(async () => { await act(async () => { commitPreferredLanguage(initialLanguage); }); });

    it('updates mounted comment, filter and toolbar labels when the committed locale changes', async () => {
        const execute = vi.fn(async () => ({ items: [comment()], cursor: null }));
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} testID="comments" />);
        await flushHookEffects();
        const keys = ['reply', 'resolve', 'bulkResolve', 'states.open', 'headerTitle'];
        for (const key of keys) expect(screen.getTextContent()).toContain(`files.reviewComments.durable.${key}`);
        await act(async () => { commitPreferredLanguage('fr'); });
        for (const key of keys) expect(screen.getTextContent()).toContain(`fr:files.reviewComments.durable.${key}`);
        expect(screen.findHostByTestId('review-comment-comment-1')).not.toBeNull();
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it.each(['edit', 'reply'] as const)('submits %s text through the real Action policy without a second confirmation', async (operation) => {
        const original = comment();
        let edited = original;
        let reply: ReviewCommentV1 | undefined;
        const confirm = vi.fn(async () => false);
        // Persistent comment transport and the host confirmation dialog are the boundaries.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            presentUserActionConfirmation: confirm,
            reviewCommentAction: async ({ actionId, input }) => {
                if (actionId === 'reviews.comments.list') return { items: [edited], cursor: null };
                if (actionId === 'reviews.comments.edit') {
                    const request = input as { nextBody: string };
                    edited = { ...original, body: request.nextBody, bodyVersion: 2, serverRevision: 2 };
                    return { comment: edited };
                }
                if (actionId === 'reviews.comments.reply') {
                    const request = input as { body: string };
                    reply = comment({ id: 'reply-1', parentCommentId: original.id, threadId: original.threadId, body: request.body });
                    return { parent: original, comment: reply };
                }
                throw new Error(`Unexpected comment operation ${actionId}`);
            },
        }));
        const execute = async (actionId: ActionId, input: unknown) => {
            const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            if (!result.ok) throw new Error(result.errorCode);
            return result.result;
        };
        modalMock.prompt.mockResolvedValue('Submitted text');
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} testID="comments" />);
        await flushHookEffects();
        if (operation === 'edit') {
            await screen.pressByTestIdAsync('review-comment-comment-1-more');
            await settleMenu();
        }
        await screen.pressByTestIdAsync(`review-comment-comment-1-${operation}`);
        await settleMenu();
        expect(operation === 'edit' ? edited.body : reply?.body).toBe('Submitted text');
        expect(modalMock.prompt).toHaveBeenCalledTimes(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('comments-mutation-error')).toBeNull();
    });

    /**
     * One ReviewComment, shown both here (the SCM review panel) and on the review result (the run's
     * shared comment store). The HTTP executor is the boundary; both UI owners run for real.
     */
    /** The review run as the result holds it: same Home and Account as the comment. */
    const RUN = { scope: { serverId: 'server-1', accountId: 'account-1' }, sessionId: 'session-1', runId: 'run-1' } as const;

    function serveRunComment() {
        let current = comment({ id: 'finding-comment', state: 'open', sessionId: 'session-1', runId: 'run-1', serverRevision: 3 });
        const execute = vi.fn(async (actionId: ActionId, input: unknown) => {
            if (actionId === 'reviews.comments.list') return { items: [current], cursor: null };
            if (actionId === 'reviews.comments.transition') {
                const request = ReviewCommentTransitionRequestV1Schema.parse(input);
                current = { ...current, state: request.toState, serverRevision: current.serverRevision + 1,
                    ...(request.reviewTriageStatus ? { reviewTriageStatus: request.reviewTriageStatus } : {}) };
                return { comment: current };
            }
            throw new Error(`unexpected action ${actionId}`);
        });
        return { execute };
    }

    it('shows a transition made here on the review result that holds the same comment', async () => {
        const { execute } = serveRunComment();
        await loadReviewRunComments({ ...RUN, execute });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} sessionId="session-1" runId="run-1" execute={execute} />);
        await flushHookEffects();

        // Opening a second placement consumes the already demanded comment window.
        expect(execute.mock.calls.filter(([id]) => id === 'reviews.comments.list')).toHaveLength(1);

        await screen.pressByTestIdAsync('review-comment-finding-comment-dismiss');
        await flushHookEffects();

        expect(readReviewRunComments(RUN).comments).toEqual([
            expect.objectContaining({ id: 'finding-comment', state: 'dismissed', serverRevision: 4 }),
        ]);
    });

    it.each(['resolved', 'dismissed'] as const)('reopens a %s comment from History through the durable Action', async (state) => {
        const closed = comment({ id: 'history-comment', state, serverRevision: 3 });
        const execute = vi.fn(async (actionId: ActionId, input: unknown) => {
            if (actionId === 'reviews.comments.list') return { items: [closed], cursor: null };
            const request = ReviewCommentTransitionRequestV1Schema.parse(input);
            return { comment: { ...closed, state: request.toState, serverRevision: 4 } };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} testID="comments" />);
        await flushHookEffects();
        await screen.pressByTestIdAsync('comments-show-history');
        await screen.pressByTestIdAsync('review-comment-history-comment-reopen');
        await flushHookEffects();
        expect(execute).toHaveBeenCalledWith('reviews.comments.transition', expect.objectContaining({
            commentId: 'history-comment', expectedState: state, expectedServerRevision: 3, toState: 'open',
        }));
        expect(screen.findHostByTestId('review-comment-history-comment')).toBeNull();
        await screen.pressByTestIdAsync('comments-show-active');
        expect(screen.findByTestId('review-comment-history-comment-resolve')).not.toBeNull();
    });

    it('reads as loading, never empty, until the first list arrives', async () => {
        let release: (value: unknown) => void = () => {};
        const execute = vi.fn(async (actionId: ActionId) => {
            if (actionId === 'reviews.comments.list') return await new Promise((resolve) => { release = resolve; });
            throw new Error('unexpected');
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} testID="comments" />);
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('files.reviewComments.durable.empty');
        await act(async () => { release({ items: [], cursor: null }); });
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('files.reviewComments.durable.empty');
        expect(screen.getTextContent()).not.toContain('common.loading');
    });

    it('puts a failed action on the card that failed and retries it from there', async () => {
        let reject = true;
        const execute = vi.fn(async (actionId: ActionId, input: unknown) => {
            if (actionId === 'reviews.comments.list') {
                return { items: [comment({ id: 'other-comment' }), comment({ id: 'failed-comment' })], cursor: null };
            }
            if (reject) throw Object.assign(new Error('private diagnostic'), { code: 'review_comment_conflict' });
            const request = ReviewCommentTransitionRequestV1Schema.parse(input);
            return { comment: comment({ id: request.commentId, state: request.toState, serverRevision: 2 }) };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} testID="comments" />);
        await flushHookEffects();
        await screen.pressByTestIdAsync('review-comment-failed-comment-resolve');
        await flushHookEffects();
        const failedCard = screen.findHostByTestId('review-comment-failed-comment');
        const otherCard = screen.findHostByTestId('review-comment-other-comment');
        expect(failedCard?.findAll((node) => node.props.testID === 'comments-mutation-error').length).toBeGreaterThan(0);
        expect(otherCard?.findAll((node) => node.props.testID === 'comments-mutation-error').length).toBe(0);
        reject = false;
        await screen.pressByTestIdAsync('comments-mutation-error-retry');
        await flushHookEffects();
        expect(execute).toHaveBeenLastCalledWith('reviews.comments.transition', expect.objectContaining({
            commentId: 'failed-comment', toState: 'resolved',
        }));
        expect(screen.findHostByTestId('comments-mutation-error')).toBeNull();
        expect(screen.findHostByTestId('review-comment-failed-comment')).toBeNull();
    });

    it('handles a rejected comment mutation inline and preserves the comment for retry', async () => {
        let reject = true;
        const execute = vi.fn(async (actionId: ActionId) => {
            if (actionId === 'reviews.comments.list') return { items: [comment({ id: 'retry-comment' })], cursor: null };
            if (reject) throw Object.assign(new Error('private diagnostic'), { code: 'review_comment_conflict' });
            return { comment: comment({ id: 'retry-comment', state: 'resolved', serverRevision: 2 }) };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} projectId="project-1" execute={execute} testID="comments" />);
        await flushHookEffects();
        await screen.pressByTestIdAsync('review-comment-retry-comment-resolve');
        await flushHookEffects();
        expect(screen.findHostByTestId('comments-mutation-error')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('private diagnostic');
        expect(screen.findByTestId('review-comment-retry-comment-resolve')).not.toBeNull();
        reject = false;
        await screen.pressByTestIdAsync('review-comment-retry-comment-resolve');
        await flushHookEffects();
        expect(screen.findHostByTestId('comments-mutation-error')).toBeNull();
        expect(screen.findHostByTestId('review-comment-retry-comment')).toBeNull();
    });

    it('shares pending decisions and confirmed native sealed comment revisions between workspace and Review windows', async () => {
        const write = deferred<{ comment: ReviewCommentV1 }>();
        const original = comment({ reviewId: 'review-native', findingId: 'native-finding', findingIdentity: 'f'.repeat(64),
            workspace: { machineId: 'machine', path: '/repo' }, reviewTriageStatus: 'defer',
            finding: { id: 'native-finding', title: 'Native finding', summary: 'body', severity: 'high', category: 'correctness' } });
        const execute = vi.fn(async (actionId: ActionId) => {
            if (actionId === 'reviews.comments.list') return { items: [original], cursor: null };
            if (actionId === 'reviews.comments.transition') return write.promise;
            throw new Error(`unexpected action ${actionId}`);
        });
        const target = { scope: RUN.scope, reviewId: original.reviewId! };
        await loadReviewRunComments({ ...target, execute });
        let saved!: Promise<boolean>;
        await act(async () => { saved = decideReviewRunFinding({ ...target, commentId: original.id, decision: 'accept', execute }); });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} workspace={original.workspace} execute={execute} />);
        await flushHookEffects();
        expect(screen.findByTestId(`review-finding-triage:${original.id}:accept`)?.props.accessibilityState?.checked).toBe(true);
        await act(async () => { write.resolve({ comment: { ...original, reviewTriageStatus: 'accept', serverRevision: 2 } }); await saved; });
        await act(async () => { recordReviewCommentWrites([{ ...original, body: 'Edited in Review', serverRevision: 3 }], RUN.scope); });
        expect(screen.getTextContent()).toContain('Edited in Review');
    });

    it('shows a decision made on the review result in this panel without a reload', async () => {
        const { execute } = serveRunComment();
        await loadReviewRunComments({ ...RUN, execute });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} sessionId="session-1" runId="run-1" execute={execute} />);
        await flushHookEffects();
        expect(screen.findByTestId('review-comment-finding-comment-dismiss')).not.toBeNull();
        const listCalls = execute.mock.calls.filter(([actionId]) => actionId === 'reviews.comments.list').length;

        await act(async () => {
            await decideReviewRunFinding({ ...RUN, commentId: 'finding-comment', decision: 'reject', execute });
        });
        await flushHookEffects();

        // Dismissed comments leave the active list for history.
        expect(screen.findByTestId('review-comment-finding-comment-dismiss')).toBeNull();
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'reviews.comments.list')).toHaveLength(listCalls);
    });

    it('does not import another Home\'s decision for the same Account and comment id', async () => {
        const { execute } = serveRunComment();
        await loadReviewRunComments({ ...RUN, execute });
        const screen = await renderScreen(<ReviewCommentsSessionSurface
            scope={{ ...RUN.scope, serverId: 'other-home' }} sessionId="session-1" runId="run-1" execute={execute} />);
        await flushHookEffects();
        await act(async () => {
            await decideReviewRunFinding({ ...RUN, commentId: 'finding-comment', decision: 'reject', execute });
        });
        await flushHookEffects();
        expect(screen.findByTestId('review-comment-finding-comment-dismiss')).not.toBeNull();
    });

    it('withdraws the old Account\'s rows even when the new Account cannot load comments', async () => {
        const { execute } = serveRunComment();
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope}
            sessionId="session-1" runId="run-1" execute={execute} />);
        await flushHookEffects();
        expect(screen.findByTestId('review-comment-finding-comment-dismiss')).not.toBeNull();
        await screen.update(<ReviewCommentsSessionSurface scope={{ ...RUN.scope, accountId: 'other-account' }}
            sessionId="session-1" runId="run-1" execute={async () => { throw new Error('offline'); }} />);
        await flushHookEffects();
        expect(screen.findByTestId('review-comment-finding-comment-dismiss')).toBeNull();
    });

    it('reads workspace-only comments without requiring a legacy workspace-ref alias', async () => {
        const execute = vi.fn(async (_actionId: ActionId, _input: unknown) => ({ items: [], cursor: null }));
        const workspace = { machineId: 'machine-1', path: '/repo' };
        await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} workspace={workspace} workspaceId="legacy-ref" execute={execute} />);
        await flushHookEffects();
        expect(execute).toHaveBeenCalledWith('reviews.comments.list', expect.objectContaining({ workspace, includeHistory: true }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('workspaceId');
    });

    it.each([{ kind: 'gutter', state: 'open' }, { kind: 'gutter', state: 'proposed' }, { kind: 'native', state: 'open' }] as const)('routes the delegation transition made here through its canonical Action ($kind, $state)', async ({ kind, state }) => {
        const sent: string[] = [];
        let current = comment({ sessionId: 'chosen-session', state, serverRevision: 3,
            ...(kind === 'native' ? { reviewId: 'review-1', findingId: 'finding-1', findingIdentity: 'f'.repeat(64),
                finding: { id: 'finding-1', title: 'A finding', summary: 'body', severity: 'high', category: 'correctness' } } : {}) });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSendMessage: async ({ message }) => { sent.push(message); return { status: 'accepted', localId: 'delegate' }; },
            reviewCommentAction: async ({ actionId, input }) => {
                if (actionId === 'reviews.comments.list') return { items: [current], cursor: null };
                if (actionId === 'reviews.comments.transition') {
                    const request = ReviewCommentTransitionRequestV1Schema.parse(input);
                    current = { ...current, state: request.toState, serverRevision: current.serverRevision + 1,
                        ...(request.reviewTriageStatus ? { reviewTriageStatus: request.reviewTriageStatus } : {}) };
                    return { comment: current };
                }
                throw new Error(`unexpected action ${actionId}`);
            },
        }));
        const execute = vi.fn(async (actionId: ActionId, input: unknown) => {
            const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            if (!result.ok) throw new Error(result.errorCode);
            return result.result;
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface scope={RUN.scope} sessionId="chosen-session" execute={execute} />);
        await flushHookEffects();
        await screen.pressByTestIdAsync('review-comment-comment-1-more');
        await settleMenu();
        await screen.pressByTestIdAsync('review-comment-comment-1-delegate');
        await settleMenu();
        await flushHookEffects();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('body');
        if (kind === 'native') {
            expect(current.reviewTriageStatus).toBe('accept');
            expect(execute).toHaveBeenCalledWith('review.apply', { sessionId: 'chosen-session', reviewId: 'review-1' }, expect.any(Object));
        } else {
            expect(current.state).toBe('delegated');
            expect(current.serverRevision).toBe(state === 'open' ? 4 : 5);
            expect(execute).toHaveBeenCalledWith('session.message.send', expect.objectContaining({ sessionId: 'chosen-session', message: expect.stringContaining('reviews.comments.setDisposition') }), expect.any(Object));
        }
    });

    it('renders durable active/history comments and preserves last-known rows only while refresh is pending', async () => {
        const secondList = deferred<{ items: ReviewCommentV1[]; cursor: null }>();
        const execute = vi.fn(async (actionId: ActionId) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            if (execute.mock.calls.length === 1) {
                return {
                    items: [
                        comment({ id: 'open-1', state: 'open', body: 'Keep visible while refreshing.', updatedAt: 2 }),
                        comment({ id: 'resolved-1', state: 'resolved', body: 'Resolved historical issue.', updatedAt: 1 }),
                    ],
                    cursor: null,
                };
            }
            return await secondList.promise;
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface scope={RUN.scope}
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Keep visible while refreshing.');
        expect(screen.getTextContent()).not.toContain('Resolved historical issue.');

        const showHistory = screen.findByTestId('review-comments-session-show-history');
        await pressTestInstanceAsync(showHistory, 'review-comments-session-show-history');
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Resolved historical issue.');
        expect(screen.getTextContent()).not.toContain('Keep visible while refreshing.');

        const showActive = screen.findByTestId('review-comments-session-show-active');
        await pressTestInstanceAsync(showActive, 'review-comments-session-show-active');
        await flushHookEffects();
        expect(screen.getTextContent()).toContain('Keep visible while refreshing.');

        const refresh = screen.findByTestId('review-comments-session-refresh');
        await pressTestInstanceAsync(refresh, 'review-comments-session-refresh');
        await flushHookEffects({ cycles: 1 });

        expect(screen.getTextContent()).toContain('Keep visible while refreshing.');

        await act(async () => {
            secondList.resolve({ items: [], cursor: null });
        });
        await flushHookEffects();
        expect(screen.getTextContent()).not.toContain('Keep visible while refreshing.');
    });

    it('keeps the product panel closed until the header button is pressed', async () => {
        const execute = vi.fn(async (actionId: ActionId) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            return {
                items: [
                    comment({ id: 'open-1', state: 'open', body: 'Opened from product header.', updatedAt: 2 }),
                ],
                cursor: null,
            };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface scope={RUN.scope}
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                defaultPanelOpen={false}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(execute).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('Opened from product header.');
        // Nothing has been read yet, so the header claims no count (never a "0" it doesn't know).
        expect(screen.getTextContent()).not.toMatch(/\d/);

        const header = screen.findByTestId('review-comments-session-header');
        await pressTestInstanceAsync(header, 'review-comments-session-header');
        await flushHookEffects();

        expect(execute).toHaveBeenCalledWith('reviews.comments.list', expect.objectContaining({
            sessionId: 'session-1',
            includeHistory: true,
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(screen.getTextContent()).toContain('Opened from product header.');
        // Read, the header says how many are open; pressed again, the panel closes.
        expect(screen.getTextContent()).toContain('1');
        await pressTestInstanceAsync(screen.findByTestId('review-comments-session-header'), 'review-comments-session-header');
        await flushHookEffects();
        expect(screen.getTextContent()).not.toContain('Opened from product header.');
    });

    it('shows redacted durable comments in history even when their state is still active', async () => {
        const execute = vi.fn(async (actionId: ActionId) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            return {
                items: [
                    comment({
                        id: 'redacted-open-1',
                        state: 'open',
                        body: 'Sensitive body.',
                        anchor: { kind: 'file', filePath: 'src/redacted.ts' },
                        flags: { redacted: true },
                        updatedAt: 2,
                    }),
                    comment({ id: 'open-1', state: 'open', body: 'Visible active finding.', updatedAt: 1 }),
                ],
                cursor: null,
            };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface scope={RUN.scope}
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Visible active finding.');
        expect(screen.getTextContent()).not.toContain('src/redacted.ts');

        await pressTestInstanceAsync(
            screen.findByTestId('review-comments-session-show-history'),
            'review-comments-session-show-history',
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('src/redacted.ts');
        expect(screen.getTextContent()).not.toContain('Sensitive body.');
    });

    it('filters active durable comments by selected state without changing the unresolved badge count', async () => {
        const execute = vi.fn(async (actionId: ActionId) => {
            if (actionId !== 'reviews.comments.list') {
                throw new Error(`unexpected action ${actionId}`);
            }
            return {
                items: [
                    comment({ id: 'open-1', state: 'open', body: 'Open finding.', updatedAt: 3 }),
                    comment({ id: 'proposed-1', state: 'proposed', body: 'Proposed finding.', updatedAt: 2 }),
                    comment({ id: 'resolved-1', state: 'resolved', body: 'Resolved finding.', updatedAt: 1 }),
                ],
                cursor: null,
            };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface scope={RUN.scope}
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Open finding.');
        expect(screen.getTextContent()).toContain('Proposed finding.');
        expect(screen.getTextContent()).not.toContain('Resolved finding.');
        expect(screen.getTextContent()).toContain('2');

        await pressTestInstanceAsync(
            screen.findByTestId('review-comment-filter-state-proposed'),
            'review-comment-filter-state-proposed',
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('Open finding.');
        expect(screen.getTextContent()).not.toContain('Proposed finding.');
        expect(screen.getTextContent()).not.toContain('Resolved finding.');
        expect(screen.getTextContent()).toContain('2');
    });

    it('wires edit reply transition redact and bulk actions through durable review actions', async () => {
        modalMock.prompt
            .mockResolvedValueOnce('Edited body')
            .mockResolvedValueOnce('Reply body');
        const execute = vi.fn(async (actionId: ActionId, input: unknown) => {
            if (actionId === 'reviews.comments.list') {
                return {
                    items: [
                        comment({ id: 'open-1', state: 'open', body: 'Open issue.', updatedAt: 2, sessionId: 'session-1' }),
                        comment({ id: 'proposed-1', state: 'proposed', body: 'Proposed issue.', updatedAt: 1, sessionId: 'session-1' }),
                    ],
                    cursor: null,
                };
            }
            if (actionId === 'reviews.comments.bulkTransition') {
                return {
                    bulkActionId: 'bulk-1',
                    updated: [],
                    failed: [{ commentId: 'open-1', errorCode: 'review_comment_permission_denied', error: 'not allowed' }],
                };
            }
            if (actionId === 'reviews.comments.reply') {
                return {
                    parent: comment({ id: 'open-1', state: 'open', body: 'Open issue.', updatedAt: 2, sessionId: 'session-1' }),
                    comment: comment({
                        id: 'reply-1',
                        parentCommentId: 'open-1',
                        threadId: 'open-1',
                        body: 'Reply body',
                        sessionId: 'session-1',
                    }),
                };
            }
            return { comment: comment({ id: 'open-1', body: `${actionId}:${JSON.stringify(input)}` }) };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface scope={RUN.scope}
                projectId="project-1"
                sessionId="session-1"
                execute={execute}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        await screen.pressByTestIdAsync('review-comment-open-1-more');
        await settleMenu();
        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-edit'), 'review-comment-open-1-edit');
        await settleMenu();
        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-resolve'), 'review-comment-open-1-resolve');
        await screen.pressByTestIdAsync('review-comment-open-1-more');
        await settleMenu();
        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-redact'), 'review-comment-open-1-redact');
        await settleMenu();
        await pressTestInstanceAsync(screen.findByTestId('review-comment-open-1-reply'), 'review-comment-open-1-reply');
        await pressTestInstanceAsync(screen.findByTestId('review-comments-session-panel-bulk-resolve'), 'review-comments-session-panel-bulk-resolve');
        await flushHookEffects();

        expect(execute).toHaveBeenCalledWith('reviews.comments.edit', expect.objectContaining({
            commentId: 'open-1',
            projectId: 'project-1',
            expectedServerRevision: 1,
            nextBody: 'Edited body',
            expectedBodyVersion: 1,
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.transition', expect.objectContaining({
            commentId: 'open-1',
            projectId: 'project-1',
            toState: 'resolved',
            expectedState: 'open',
            expectedServerRevision: 1,
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.redact', expect.objectContaining({
            commentId: 'open-1',
            projectId: 'project-1',
            expectedServerRevision: 1,
            redactBody: true,
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.reply', expect.objectContaining({
            parentCommentId: 'open-1',
            projectId: 'project-1',
            expectedParentServerRevision: 1,
            body: 'Reply body',
        }));
        expect(execute).toHaveBeenCalledWith('reviews.comments.bulkTransition', expect.objectContaining({
            projectId: 'project-1', commentIds: ['open-1', 'reply-1'], expectedState: 'open',
            expectedServerRevisions: { 'open-1': 1, 'reply-1': 1 }, toState: 'resolved',
        }));
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'reviews.comments.bulkTransition'))
            .not.toContainEqual(['reviews.comments.bulkTransition', expect.objectContaining({ expectedState: 'proposed' })]);
        expect(screen.getTextContent()).toContain('files.reviewComments.durable.bulkPartialFailure');
        expect(screen.getTextContent()).toContain('open-1:review_comment_permission_denied');
        expect(screen.getTextContent()).toContain('review_comment_permission_denied');
    });
});
