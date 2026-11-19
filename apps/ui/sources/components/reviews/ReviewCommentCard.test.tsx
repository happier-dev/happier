import React from 'react';
import { act } from 'react-test-renderer';
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
// The popover's portal and window measurement are the boundary; the real menu and its rows render inline.
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

/** A menu opens and selects on the next frame (its own scheduling, with a timer fallback); wait it out. */
const settleMenu = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
async function pickFromMore(screen: Awaited<ReturnType<typeof renderScreen>>, cardTestID: string, itemId: string) {
    await screen.pressByTestIdAsync(`${cardTestID}-more`);
    await settleMenu();
    await screen.pressByTestIdAsync(`${cardTestID}-${itemId}`);
    await settleMenu();
}

describe('ReviewCommentCard', () => {
    it('renders a native sealed finding through the same body as Review detail', async () => {
        const comment = buildReviewCommentFixture({ reviewId: 'review-1', findingId: 'finding-1', finding: {
            id: 'finding-1', title: 'A native finding', summary: 'Original explanation', severity: 'high', category: 'correctness',
            whyItMatters: 'Its impact', evidence: 'Verified evidence',
        }, body: 'Current explanation' });
        const screen = await renderScreen(<ReviewCommentCard comment={comment} labels={reviewCommentLabelsFixture} />);
        expect(screen.findHostByTestId('review-finding-body:comment-1')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Current explanation');
        expect(screen.getTextContent()).toContain('Verified evidence');
    });

    it('offers Open and Dismiss for a proposal, never an invalid Resolve', async () => {
        const onTransition = vi.fn();
        const comment = buildReviewCommentFixture({ id: 'proposal', state: 'proposed' });
        const screen = await renderScreen(<ReviewCommentCard comment={comment} labels={reviewCommentLabelsFixture}
            actions={{ onTransition }} testID="proposal" />);
        expect(screen.findByTestId('proposal-resolve')).toBeNull();
        await screen.pressByTestIdAsync('proposal-open');
        expect(onTransition).toHaveBeenCalledWith({ comment, toState: 'open' });
        expect(screen.findByTestId('proposal-dismiss')).not.toBeNull();
    });

    it('keeps the state\'s move, Dismiss and Reply on the row and every other action behind one More', async () => {
        const onEdit = vi.fn();
        const onRedact = vi.fn();
        const onDelegate = vi.fn();
        const onTransition = vi.fn();
        const onReply = vi.fn();
        const comment = buildReviewCommentFixture({ id: 'comment-1', state: 'open' });
        const screen = await renderScreen(
            <ReviewCommentCard
                comment={comment}
                labels={reviewCommentLabelsFixture}
                actions={{ onEdit, onTransition, onRedact, onDelegate, onReply }}
                testID="review-card"
            />,
        );

        for (const id of ['resolve', 'dismiss', 'reply', 'more']) expect(screen.findByTestId(`review-card-${id}`)).not.toBeNull();
        for (const id of ['edit', 'redact', 'delegate']) expect(screen.findByTestId(`review-card-${id}`)).toBeNull();

        await pressTestInstanceAsync(screen.findByTestId('review-card-resolve'), 'review-card-resolve');
        await pressTestInstanceAsync(screen.findByTestId('review-card-dismiss'), 'review-card-dismiss');
        await pressTestInstanceAsync(screen.findByTestId('review-card-reply'), 'review-card-reply');
        expect(onTransition).toHaveBeenCalledWith({ comment, toState: 'resolved' });
        expect(onTransition).toHaveBeenCalledWith({ comment, toState: 'dismissed' });
        expect(onReply).toHaveBeenCalledWith(comment);

        await pickFromMore(screen, 'review-card', 'edit');
        await pickFromMore(screen, 'review-card', 'delegate');
        await pickFromMore(screen, 'review-card', 'redact');
        expect(onEdit).toHaveBeenCalledWith(comment);
        expect(onDelegate).toHaveBeenCalledWith(comment);
        expect(onRedact).toHaveBeenCalledWith(comment);
    });

    it('reaches a delegated comment\'s non-primary move through More', async () => {
        const onTransition = vi.fn();
        const comment = buildReviewCommentFixture({ id: 'delegated', state: 'delegated' });
        const screen = await renderScreen(<ReviewCommentCard comment={comment} labels={reviewCommentLabelsFixture}
            actions={{ onTransition }} testID="delegated" />);
        expect(screen.findByTestId('delegated-open')).toBeNull();
        await pickFromMore(screen, 'delegated', 'open');
        expect(onTransition).toHaveBeenCalledWith({ comment, toState: 'open' });
    });

    it('draws Show more straight after the folded text, not on the action row', async () => {
        const comment = buildReviewCommentFixture({ id: 'long', body: 'Title\n\nThe lead.\n\nMore detail.' });
        const screen = await renderScreen(<ReviewCommentCard comment={comment} labels={reviewCommentLabelsFixture}
            actions={{ onTransition: vi.fn() }} testID="long" />);
        const order = screen.findAll((node) => typeof node.props?.testID === 'string' && /^long-(fold|resolve)$/.test(node.props.testID))
            .map((node) => node.props.testID as string);
        expect(order[0]).toBe('long-fold');
        expect(order).toContain('long-resolve');
    });

    it('hides absent action handlers and disables actions for redacted comments', async () => {
        const unauthorized = await renderScreen(
            <ReviewCommentCard
                comment={buildReviewCommentFixture({ id: 'comment-1' })}
                labels={reviewCommentLabelsFixture}
                testID="unauthorized-card"
            />,
        );
        expect(unauthorized.findByTestId('unauthorized-card-resolve')).toBeNull();
        expect(unauthorized.findByTestId('unauthorized-card-more')).toBeNull();

        const onEdit = vi.fn();
        const redacted = await renderScreen(
            <ReviewCommentCard
                comment={buildReviewCommentFixture({ id: 'comment-2', flags: { redacted: true } })}
                labels={reviewCommentLabelsFixture}
                actions={{ onEdit, onTransition: vi.fn() }}
                testID="redacted-card"
            />,
        );
        expect(redacted.findByTestId('redacted-card-resolve')?.props.disabled).toBe(true);
        expect(redacted.findByTestId('redacted-card-more')?.props.disabled).toBe(true);
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
