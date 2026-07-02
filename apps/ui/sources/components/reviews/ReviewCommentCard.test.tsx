import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    buildReviewCommentFixture,
    pressTestInstanceAsync,
    renderScreen,
    reviewCommentLabelsFixture,
} from '@/dev/testkit';

import { ReviewCommentCard } from './ReviewCommentCard';

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

describe('ReviewCommentCard', () => {
    it('renders authorized edit and transition affordances from durable actions', async () => {
        const onEdit = vi.fn();
        const onTransition = vi.fn();
        const onRedact = vi.fn();
        const comment = buildReviewCommentFixture({ id: 'comment-1', state: 'open' });
        const screen = await renderScreen(
            <ReviewCommentCard
                comment={comment}
                labels={reviewCommentLabelsFixture}
                actions={{ onEdit, onTransition, onRedact }}
                testID="review-card"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('review-card-edit'), 'review-card-edit');
        await pressTestInstanceAsync(screen.findByTestId('review-card-resolve'), 'review-card-resolve');
        await pressTestInstanceAsync(screen.findByTestId('review-card-dismiss'), 'review-card-dismiss');
        await pressTestInstanceAsync(screen.findByTestId('review-card-redact'), 'review-card-redact');

        expect(onEdit).toHaveBeenCalledWith(comment);
        expect(onTransition).toHaveBeenCalledWith({ comment, toState: 'resolved' });
        expect(onTransition).toHaveBeenCalledWith({ comment, toState: 'dismissed' });
        expect(onRedact).toHaveBeenCalledWith(comment);
    });

    it('hides absent action handlers and disables actions for redacted comments', async () => {
        const unauthorized = await renderScreen(
            <ReviewCommentCard
                comment={buildReviewCommentFixture({ id: 'comment-1' })}
                labels={reviewCommentLabelsFixture}
                testID="unauthorized-card"
            />,
        );
        expect(unauthorized.findByTestId('unauthorized-card-edit')).toBeNull();
        expect(unauthorized.findByTestId('unauthorized-card-resolve')).toBeNull();

        const onEdit = vi.fn();
        const redacted = await renderScreen(
            <ReviewCommentCard
                comment={buildReviewCommentFixture({ id: 'comment-2', flags: { redacted: true } })}
                labels={reviewCommentLabelsFixture}
                actions={{ onEdit, onTransition: vi.fn() }}
                testID="redacted-card"
            />,
        );
        expect(redacted.findByTestId('redacted-card-edit')?.props.disabled).toBe(true);
        expect(onEdit).not.toHaveBeenCalled();
    });

    it('renders unavailable content labels for encrypted body and snapshot envelopes', async () => {
        const screen = await renderScreen(
            <ReviewCommentCard
                comment={buildReviewCommentFixture({
                    id: 'encrypted-1',
                    body: { t: 'encrypted', c: 'ciphertext' },
                    snapshot: { t: 'encrypted', c: 'snapshot-ciphertext' },
                })}
                labels={reviewCommentLabelsFixture}
                testID="encrypted-card"
            />,
        );

        expect(screen.getTextContent()).toContain('Content unavailable');
        expect(screen.getTextContent()).toContain('Encrypted snapshot');
    });
});
