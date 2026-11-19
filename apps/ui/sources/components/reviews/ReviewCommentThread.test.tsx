import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import {
    buildReviewCommentFixture,
    pressTestInstanceAsync,
    renderScreen,
    reviewCommentLabelsFixture,
} from '@/dev/testkit';

import { ReviewCommentsList, type ReviewCommentsListProps } from './ReviewCommentsList';

// The native recycler is the physical layout boundary for these action tests.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
});

function ReviewCommentThread({ root, replies, ...props }: Omit<ReviewCommentsListProps, 'comments'> & {
    root: ReviewCommentV1;
    replies: readonly ReviewCommentV1[];
}) {
    return <ReviewCommentsList {...props} comments={[root, ...replies]} />;
}

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

describe('ReviewCommentThread', () => {
    it('enables replies for open threads', async () => {
        const onReply = vi.fn();
        const screen = await renderScreen(
            <ReviewCommentThread
                root={buildReviewCommentFixture({ id: 'root-1', state: 'open' })}
                replies={[]}
                labels={reviewCommentLabelsFixture}
                onReply={onReply}
                testID="review-thread"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('review-comment-root-1-reply'), 'review-comment-root-1-reply');

        expect(onReply).toHaveBeenCalledWith({ parentCommentId: 'root-1' });
    });

    it('offers one Reply for the whole thread, on the root comment\'s action row', async () => {
        const screen = await renderScreen(
            <ReviewCommentThread
                root={buildReviewCommentFixture({ id: 'root-1', state: 'open' })}
                replies={[buildReviewCommentFixture({ id: 'reply-1', parentCommentId: 'root-1', threadId: 'root-1', createdAt: 2 })]}
                labels={reviewCommentLabelsFixture}
                cardActions={{ onTransition: vi.fn() }}
                onReply={vi.fn()}
            />,
        );
        expect(screen.findAllHostsByTestId('review-comment-root-1-reply')).toHaveLength(1);
        expect(screen.findByTestId('review-comment-reply-1-reply')).toBeNull();
    });

    it('disables replies for closed tombstoned and redacted threads', async () => {
        const onReply = vi.fn();
        const closed = await renderScreen(
            <ReviewCommentThread
                root={buildReviewCommentFixture({ id: 'closed-1', state: 'resolved' })}
                replies={[]}
                labels={reviewCommentLabelsFixture}
                onReply={onReply}
                testID="closed-thread"
            />,
        );
        expect(closed.findByTestId('review-comment-closed-1-reply')?.props.accessibilityState).toMatchObject({ disabled: true });

        const redacted = await renderScreen(
            <ReviewCommentThread
                root={buildReviewCommentFixture({ id: 'redacted-1', flags: { redacted: true } })}
                replies={[]}
                labels={reviewCommentLabelsFixture}
                onReply={onReply}
                testID="redacted-thread"
            />,
        );
        expect(redacted.findByTestId('review-comment-redacted-1-reply')?.props.accessibilityState).toMatchObject({ disabled: true });

        const tombstoned = await renderScreen(
            <ReviewCommentThread
                root={buildReviewCommentFixture({
                    id: 'deleted-1',
                    tombstone: { deletedAt: 1, deletedBy: { kind: 'user', userId: 'user-1' }, redacted: true, reason: 'removed' },
                })}
                replies={[]}
                labels={reviewCommentLabelsFixture}
                onReply={onReply}
                testID="deleted-thread"
            />,
        );
        expect(tombstoned.findByTestId('review-comment-deleted-1-reply')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(onReply).not.toHaveBeenCalled();
    });
});
