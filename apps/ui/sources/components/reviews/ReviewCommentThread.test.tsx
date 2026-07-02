import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    buildReviewCommentFixture,
    pressTestInstanceAsync,
    renderScreen,
    reviewCommentLabelsFixture,
} from '@/dev/testkit';

import { ReviewCommentThread } from './ReviewCommentThread';

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

        await pressTestInstanceAsync(screen.findByTestId('review-thread-reply'), 'review-thread-reply');

        expect(onReply).toHaveBeenCalledWith({ parentCommentId: 'root-1' });
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
        expect(closed.findByTestId('closed-thread-reply')?.props.accessibilityState).toMatchObject({ disabled: true });

        const redacted = await renderScreen(
            <ReviewCommentThread
                root={buildReviewCommentFixture({ id: 'redacted-1', flags: { redacted: true } })}
                replies={[]}
                labels={reviewCommentLabelsFixture}
                onReply={onReply}
                testID="redacted-thread"
            />,
        );
        expect(redacted.findByTestId('redacted-thread-reply')?.props.accessibilityState).toMatchObject({ disabled: true });

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
        expect(tombstoned.findByTestId('deleted-thread-reply')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(onReply).not.toHaveBeenCalled();
    });
});
