import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewCommentActionIdV1} from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewCommentTransitionRequestV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { commitPreferredLanguage, getPreferredLanguage } from '@/text/preferredLanguage';
import type {
    PluginPermissionGrant,
    PluginPermissionPendingGrantRequest,
} from '@/sync/domains/plugins/permissions/types';

import {
    decideReviewRunFinding,
    loadReviewRunComments,
    readReviewRunComments,
    resetReviewRunCommentsForTests,
} from '@/sync/domains/reviews/comments/reviewRunComments';

import { ReviewCommentsSessionSurface } from './ReviewCommentsSessionSurface';
const submitMessageSpy = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/sync/sync', () => ({ sync: { submitMessage: (...args: unknown[]) => submitMessageSpy(...args) } }));

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
        if (key === 'files.reviewComments.durable.directWriteGrant.body') return String(params?.pluginId ?? '');
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
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: overrides.projectId ?? 'project-1',
        workspaceId: overrides.workspaceId,
        runId: overrides.runId,
        engineId: overrides.engineId,
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'body',
        bodyVersion: 1,
        edits: [],
        author: overrides.author ?? { kind: 'plugin', pluginId: 'review-coderabbit' },
        state: overrides.state ?? 'open',
        flags: overrides.flags ?? {},
        dispositions: {},
        threadId: overrides.threadId ?? overrides.id ?? 'comment-1',
        transitions: [
            {
                transitionId: 'transition-1',
                toState: overrides.state ?? 'open',
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                serverRevision: 1,
            },
        ],
        createdAt: 1,
        updatedAt: overrides.updatedAt ?? 1,
        serverRevision: overrides.serverRevision ?? 1,
        ...overrides,
    };
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
    let initialLanguage: ReturnType<typeof getPreferredLanguage>;
    beforeEach(() => {
        initialLanguage = getPreferredLanguage();
        commitPreferredLanguage('en');
        modalMock.prompt.mockReset();
        submitMessageSpy.mockReset();
        resetReviewRunCommentsForTests();
    });
    afterEach(async () => { await act(async () => { commitPreferredLanguage(initialLanguage); }); });

    it('updates mounted comment, filter and toolbar labels when the committed locale changes', async () => {
        const execute = vi.fn(async () => ({ items: [comment()], cursor: null }));
        const screen = await renderScreen(<ReviewCommentsSessionSurface projectId="project-1" execute={execute} testID="comments" />);
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
        const execute = async (actionId: ReviewCommentActionIdV1, input: unknown) => {
            const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            if (!result.ok) throw new Error(result.errorCode);
            return result.result;
        };
        modalMock.prompt.mockResolvedValue('Submitted text');
        const screen = await renderScreen(<ReviewCommentsSessionSurface projectId="project-1" execute={execute} testID="comments" />);
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
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1, input: unknown) => {
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

        await screen.pressByTestIdAsync('review-comment-finding-comment-dismiss');
        await flushHookEffects();

        expect(readReviewRunComments(RUN).comments).toEqual([
            expect.objectContaining({ id: 'finding-comment', state: 'dismissed', serverRevision: 4 }),
        ]);
    });

    it.each(['resolved', 'dismissed'] as const)('reopens a %s comment from History through the durable Action', async (state) => {
        const closed = comment({ id: 'history-comment', state, serverRevision: 3 });
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1, input: unknown) => {
            if (actionId === 'reviews.comments.list') return { items: [closed], cursor: null };
            const request = ReviewCommentTransitionRequestV1Schema.parse(input);
            return { comment: { ...closed, state: request.toState, serverRevision: 4 } };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface projectId="project-1" execute={execute} testID="comments" />);
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
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
            if (actionId === 'reviews.comments.list') return await new Promise((resolve) => { release = resolve; });
            throw new Error('unexpected');
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface projectId="project-1" execute={execute} testID="comments" />);
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
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1, input: unknown) => {
            if (actionId === 'reviews.comments.list') {
                return { items: [comment({ id: 'other-comment' }), comment({ id: 'failed-comment' })], cursor: null };
            }
            if (reject) throw Object.assign(new Error('private diagnostic'), { code: 'review_comment_conflict' });
            const request = ReviewCommentTransitionRequestV1Schema.parse(input);
            return { comment: comment({ id: request.commentId, state: request.toState, serverRevision: 2 }) };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface projectId="project-1" execute={execute} testID="comments" />);
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
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
            if (actionId === 'reviews.comments.list') return { items: [comment({ id: 'retry-comment' })], cursor: null };
            if (reject) throw Object.assign(new Error('private diagnostic'), { code: 'review_comment_conflict' });
            return { comment: comment({ id: 'retry-comment', state: 'resolved', serverRevision: 2 }) };
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface projectId="project-1" execute={execute} testID="comments" />);
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
        const execute = vi.fn(async (_actionId: ReviewCommentActionIdV1, _input: unknown) => ({ items: [], cursor: null }));
        const workspace = { machineId: 'machine-1', path: '/repo' };
        await renderScreen(<ReviewCommentsSessionSurface workspace={workspace} workspaceId="legacy-ref" execute={execute} />);
        await flushHookEffects();
        expect(execute).toHaveBeenCalledWith('reviews.comments.list', expect.objectContaining({ workspace, includeHistory: true }));
        expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('workspaceId');
    });

    it.each(['open', 'proposed'] as const)('delegates a %s file comment with distinct CAS writes and its updated revision', async (initialState) => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
        const original = comment({ state: initialState, serverRevision: 3 });
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1, input: unknown) => {
            if (actionId === 'reviews.comments.list') return { items: [original], cursor: null };
            if (actionId === 'reviews.comments.transition') {
                const request = ReviewCommentTransitionRequestV1Schema.parse(input);
                return { comment: comment({ state: request.toState, serverRevision: request.expectedServerRevision + 1 }) };
            }
            throw new Error(`unexpected action ${actionId}`);
        });
        const screen = await renderScreen(<ReviewCommentsSessionSurface projectId="project-1" sessionId="chosen-session" execute={execute} />);
        await flushHookEffects();
        await screen.pressByTestIdAsync('review-comment-comment-1-more');
        await settleMenu();
        await screen.pressByTestIdAsync('review-comment-comment-1-delegate');
        await settleMenu();
        await flushHookEffects();
        clock.mockRestore();
        expect(execute).toHaveBeenCalledWith('reviews.comments.transition', expect.objectContaining({
            commentId: 'comment-1', projectId: 'project-1', toState: 'delegated',
            expectedState: 'open', expectedServerRevision: initialState === 'open' ? 3 : 4, clientMutationId: expect.any(String),
        }));
        const mutations = execute.mock.calls.filter(([id]) => id === 'reviews.comments.transition')
            .map(([, input]) => ReviewCommentTransitionRequestV1Schema.parse(input).clientMutationId);
        expect(new Set(mutations).size).toBe(initialState === 'open' ? 1 : 2);
        expect(submitMessageSpy).toHaveBeenCalledWith('chosen-session', expect.stringContaining(`"expectedServerRevision": ${initialState === 'open' ? 4 : 5}`), expect.any(String), undefined, expect.any(Object));
        expect(submitMessageSpy.mock.calls[0]?.[1]).toContain('reviews.comments.setDisposition');
        expect(submitMessageSpy.mock.calls[0]?.[1]).toContain('body');
    });

    it('renders durable active/history comments and preserves last-known rows only while refresh is pending', async () => {
        const secondList = deferred<{ items: ReviewCommentV1[]; cursor: null }>();
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
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
            <ReviewCommentsSessionSurface
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
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
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
            <ReviewCommentsSessionSurface
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
        }));
        expect(screen.getTextContent()).toContain('Opened from product header.');
        // Read, the header says how many are open; pressed again, the panel closes.
        expect(screen.getTextContent()).toContain('1');
        await pressTestInstanceAsync(screen.findByTestId('review-comments-session-header'), 'review-comments-session-header');
        await flushHookEffects();
        expect(screen.getTextContent()).not.toContain('Opened from product header.');
    });

    it('shows redacted durable comments in history even when their state is still active', async () => {
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
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
            <ReviewCommentsSessionSurface
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
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
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
            <ReviewCommentsSessionSurface
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

    it('projects exact plugin grant rows and routes grant, dismiss, and revoke by durable identity', async () => {
        const onGrantDirectWrite = vi.fn();
        const onCancelDirectWriteGrant = vi.fn();
        const onRevokeDirectWrite = vi.fn();
        const pendingDirectWriteGrantRequest: PluginPermissionPendingGrantRequest = {
            v: 1,
            id: 'request-1',
            accountId: 'account-1',
            pluginId: 'review-coderabbit',
            pluginName: 'CodeRabbit',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'project-1' },
            subject: { kind: 'general' },
            requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
            authoritySource: { kind: 'bundled' },
            reason: 'Write approved review comments without another prompt.',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
        };
        const activeDirectWriteGrant: PluginPermissionGrant = {
            v: 1,
            id: 'grant-1',
            accountId: 'account-1',
            pluginId: 'review-deepsec',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'project-1' },
            subject: { kind: 'general' },
            authoritySource: { kind: 'bundled' },
            status: 'active',
            requestId: 'request-deepsec',
            grantedByUserId: 'user-1',
            grantedAt: 1,
            createdAt: 1,
            updatedAt: 1,
        };
        const secondPendingRequest: PluginPermissionPendingGrantRequest = {
            ...pendingDirectWriteGrantRequest,
            id: 'request-2',
            pluginId: 'review-second',
            pluginName: 'Second reviewer',
            requester: { kind: 'plugin', pluginId: 'review-second', sessionId: 'session-1' },
            createdAt: 2,
            updatedAt: 2,
        };
        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={async () => ({ items: [], cursor: null })}
                directWriteGrants={[activeDirectWriteGrant]}
                pendingDirectWriteGrantRequests={[pendingDirectWriteGrantRequest, secondPendingRequest]}
                permissionGrantActions={{
                    grant: onGrantDirectWrite,
                    dismissRequest: onCancelDirectWriteGrant,
                    revoke: onRevokeDirectWrite,
                }}
                onGrantDirectWrite={onGrantDirectWrite}
                onCancelDirectWriteGrant={onCancelDirectWriteGrant}
                onRevokeDirectWrite={onRevokeDirectWrite}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.getTextContent()).toContain('CodeRabbit');
        expect(screen.getTextContent()).toContain('review-coderabbit');
        expect(screen.getTextContent()).toContain('reviews.comments.write.direct');
        expect(screen.getTextContent()).toContain('project:project-1');
        expect(screen.getTextContent()).toContain('Write approved review comments without another prompt.');
        expect(screen.getTextContent()).toContain('review-deepsec');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-scope')?.props.children).toBe('project:project-1');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-actor')?.props.children).toBe('user-1');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-authority')?.props.children).toBe('bundled');
        expect(screen.findByTestId('review-comments-session-direct-write-grant-grant-1-created')?.props.children).toBe('1970-01-01T00:00:00.001Z');
        expect(screen.getTextContent()).toContain('Second reviewer');
        expect(screen.findByTestId('review-comments-session-direct-write-request-request-2')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Direct write enabled');
        expect(onGrantDirectWrite).not.toHaveBeenCalled();

        const grantButton = screen.findByTestId('review-comments-session-direct-write-request-request-1-grant');
        await pressTestInstanceAsync(grantButton, 'review-comments-session-direct-write-request-request-1-grant');

        expect(onGrantDirectWrite).toHaveBeenCalledWith({ requestId: 'request-1' });
        expect(onGrantDirectWrite).toHaveBeenCalledTimes(1);

        const cancelButton = screen.findByTestId('review-comments-session-direct-write-request-request-1-dismiss');
        await pressTestInstanceAsync(cancelButton, 'review-comments-session-direct-write-request-request-1-dismiss');

        expect(onCancelDirectWriteGrant).toHaveBeenCalledWith({ requestId: 'request-1' });
        expect(onCancelDirectWriteGrant).toHaveBeenCalledTimes(1);

        const revokeButton = screen.findByTestId('review-comments-session-direct-write-grant-grant-1-revoke');
        await pressTestInstanceAsync(revokeButton, 'review-comments-session-direct-write-grant-grant-1-revoke');
        expect(onRevokeDirectWrite).toHaveBeenCalledWith({ grantId: 'grant-1' });
        expect(onRevokeDirectWrite).toHaveBeenCalledTimes(1);
    });

    it('keeps projected grants visible offline and exposes an explicit reconnect refresh', async () => {
        const onRefreshPermissionGrants = vi.fn();
        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={async () => ({ items: [], cursor: null })}
                directWriteGrants={[{
                    v: 1,
                    id: 'grant-1',
                    accountId: 'account-1',
                    pluginId: 'review-deepsec',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'project', projectId: 'project-1' },
                    subject: { kind: 'general' },
                    authoritySource: { kind: 'bundled' },
                    status: 'active',
                    grantedByUserId: 'user-1',
                    grantedAt: 1,
                    createdAt: 1,
                    updatedAt: 1,
                }]}
                pendingDirectWriteGrantRequests={[]}
                permissionGrantStatus="error"
                permissionGrantError="offline"
                onRefreshPermissionGrants={onRefreshPermissionGrants}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.findByTestId('review-comments-session-permission-grants-error')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('offline');
        expect(screen.getTextContent()).toContain('review-deepsec');
        await pressTestInstanceAsync(
            screen.findByTestId('review-comments-session-permission-grants-refresh'),
            'review-comments-session-permission-grants-refresh',
        );
        expect(onRefreshPermissionGrants).toHaveBeenCalledTimes(1);
    });

    it('ignores pending grants for capabilities outside review-comment direct writes', async () => {
        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
                projectId="project-1"
                sessionId="session-1"
                execute={async () => ({ items: [], cursor: null })}
                directWriteGrants={[]}
                pendingDirectWriteGrantRequests={[{
                    v: 1,
                    id: 'request-1',
                    accountId: 'account-1',
                    pluginId: 'credential-plugin',
                    pluginName: 'Credential Plugin',
                    capability: 'credentials.materialize.raw',
                    targetScope: { kind: 'project', projectId: 'project-1' },
                    subject: { kind: 'general' },
                    requester: { kind: 'plugin', pluginId: 'credential-plugin', sessionId: 'session-1' },
                    authoritySource: { kind: 'bundled' },
                    reason: 'Materialize raw credentials.',
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }]}
                testID="review-comments-session"
            />,
        );
        await flushHookEffects();

        expect(screen.findByTestId('review-comments-session-direct-write-request-request-1')).toBeNull();
        expect(screen.getTextContent()).not.toContain('credentials.materialize.raw');
    });

    it('wires edit reply transition redact and bulk actions through durable review actions', async () => {
        modalMock.prompt
            .mockResolvedValueOnce('Edited body')
            .mockResolvedValueOnce('Reply body');
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1, input: unknown) => {
            if (actionId === 'reviews.comments.list') {
                return {
                    items: [
                        comment({ id: 'open-1', state: 'open', body: 'Open issue.', updatedAt: 2 }),
                        comment({ id: 'proposed-1', state: 'proposed', body: 'Proposed issue.', updatedAt: 1 }),
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
                    parent: comment({ id: 'open-1', state: 'open', body: 'Open issue.', updatedAt: 2 }),
                    comment: comment({
                        id: 'reply-1',
                        parentCommentId: 'open-1',
                        threadId: 'open-1',
                        body: 'Reply body',
                    }),
                };
            }
            return { comment: comment({ id: 'open-1', body: `${actionId}:${JSON.stringify(input)}` }) };
        });

        const screen = await renderScreen(
            <ReviewCommentsSessionSurface
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
