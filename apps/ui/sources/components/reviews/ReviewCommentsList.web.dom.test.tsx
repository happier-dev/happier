// @vitest-environment jsdom

import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { buildReviewCommentFixture, reviewCommentLabelsFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';
import { installClampedWebScrollGeometry } from '@/dev/testkit/legend/webScrollGeometry';

import { ReviewCommentsHistoryView } from './ReviewCommentsHistoryView';
import { ReviewCommentsPanel } from './ReviewCommentsPanel';
import type { ReviewCommentCardActions } from './ReviewCommentCard';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

describe('review comments mounted viewport', () => {
    const harness = createWebListDomHarness({ rowSelector: '[data-testid^="review-comment-census-"]', rowHeight: 160 });

    it('refreshes visible labels and action callbacks when comment data stays unchanged', async () => {
        const comment = buildReviewCommentFixture({ id: 'census-current' });
        const comments = [comment];
        const previousTransition = vi.fn();
        const currentTransition = vi.fn();
        const previousActions = { onTransition: previousTransition };
        const currentActions = { onTransition: currentTransition };
        const labels = { ...reviewCommentLabelsFixture, filtersTitle: 'Filters' };
        const currentLabels = { ...labels, states: { ...labels.states, open: 'Current decision label' } };
        const render = (currentLabels: typeof labels, cardActions: ReviewCommentCardActions) => (
            <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                <ReviewCommentsPanel comments={comments} labels={currentLabels} cardActions={cardActions} />
            </div>
        );
        await act(async () => harness.root.render(render(labels, previousActions)));
        await harness.flush();
        await act(async () => harness.root.render(render(currentLabels, previousActions)));
        await harness.flush();
        expect(harness.container.textContent).toContain('Current decision label');
        await act(async () => harness.root.render(render(currentLabels, currentActions)));
        await harness.flush();
        await act(async () => harness.container.querySelector<HTMLElement>('[data-testid="review-comment-census-current-resolve"]')!.click());
        expect(currentTransition).toHaveBeenCalledWith({ comment, toState: 'resolved' });
        expect(previousTransition).not.toHaveBeenCalled();
    });

    it.each(['threads', 'replies', 'history'] as const)('bounds %s cards and keeps later comments readable', async (kind) => {
        // Plan 02 U3's 1k scale shape, including a single thread with many replies.
        const comments = Array.from({ length: 1_000 }, (_, index) => buildReviewCommentFixture({
            id: `census-${index}`,
            body: index === 0 || index === 999
                ? `Finding ${index}\n\nSummary.\n\nDetails for ${index}.`
                : `Finding ${index}`,
            state: kind === 'history' ? 'resolved' : 'open',
            createdAt: index,
            ...(kind === 'replies' ? { threadId: 'census-0', parentCommentId: index === 0 ? undefined : 'census-0' } : {}),
        }));
        const onReply = vi.fn();
        const onLoadMore = vi.fn();
        const listFooter = <button onClick={onLoadMore}>Load more comments</button>;
        await act(async () => harness.root.render(
            <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                {kind === 'history'
                    ? <ReviewCommentsHistoryView comments={comments} labels={reviewCommentLabelsFixture} listFooter={listFooter} testID="comments" />
                    : <ReviewCommentsPanel comments={comments} labels={{ ...reviewCommentLabelsFixture, filtersTitle: 'Filters' }}
                        onReply={onReply} listFooter={listFooter} testID="comments" />}
            </div>,
        ));
        await harness.flush();
        const mountedCards = () => [...harness.container.querySelectorAll('[data-testid]')]
            .filter((element) => /^review-comment-census-\d+$/.test(element.getAttribute('data-testid') ?? ''));
        expect(mountedCards().length).toBeGreaterThan(0);
        expect(mountedCards().length).toBeLessThan(comments.length / 10);
        expect(harness.container.textContent).toContain('Finding 0');
        const fold = harness.container.querySelector<HTMLElement>('[data-testid="review-comment-census-0-fold"]')!;
        await act(async () => fold.click());
        await harness.flush();
        expect(harness.container.textContent).toContain('Details for 0.');
        if (kind === 'replies') {
            const reply = harness.container.querySelector<HTMLElement>('[data-testid="review-comment-census-0-reply"]')!;
            await act(async () => reply.click());
            expect(onReply).toHaveBeenCalledWith({ parentCommentId: 'census-0' });
            expect(harness.container.querySelector('[data-testid="review-comment-census-1-reply"]')).toBeNull();
        }

        installClampedWebScrollGeometry();
        const scrollOwner = [...harness.container.querySelectorAll<HTMLElement>('[style]')]
            .find((element) => element.style.overflowY === 'auto' || element.style.overflow === 'auto')!;
        await act(async () => scrollOwner.scrollTo({ top: scrollOwner.scrollHeight }));
        await harness.flush();
        expect(harness.container.textContent).toContain('Finding 999');
        expect(mountedCards().length).toBeLessThan(comments.length / 10);
        expect(harness.container.textContent).not.toContain('Details for 999.');
        await act(async () => [...harness.container.querySelectorAll('button')]
            .find((button) => button.textContent === 'Load more comments')!.click());
        expect(onLoadMore).toHaveBeenCalledOnce();

        await act(async () => scrollOwner.scrollTo({ top: 0 }));
        await harness.flush();
        expect(harness.container.textContent).toContain('Details for 0.');
    });
});
