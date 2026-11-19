import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { pressTestInstanceAsync, renderScreen, reviewCommentLabelsFixture } from '@/dev/testkit';

import { ReviewCommentsHeaderButton } from './ReviewCommentsHeaderButton';
import { ReviewCommentsHistoryView } from './ReviewCommentsHistoryView';
import { ReviewCommentsPanel } from './ReviewCommentsPanel';

// The native recycler is the physical layout boundary; list/card behavior stays real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: 'project-1',
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'Fix this.',
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
        updatedAt: 1,
        serverRevision: 1,
        ...overrides,
    };
}

const labels = { ...reviewCommentLabelsFixture, filtersTitle: 'Filters' };

describe('review comments panel components', () => {
    it('renders filters durable comments history badge and explicit grant copy', async () => {
        const comments = [
            comment({ id: 'open-1', state: 'open', body: 'Open issue.' }),
            comment({ id: 'resolved-1', state: 'resolved', body: 'Resolved issue.' }),
        ];

        const panel = await renderScreen(
            <ReviewCommentsPanel
                comments={comments}
                labels={labels}
                selectedStates={['open']}
            />,
        );
        expect(panel.findHostByTestId('review-comment-filter-state-open')?.props['aria-pressed']).toBe(true);
        expect(panel.findHostByTestId('review-comment-filter-state-proposed')?.props['aria-pressed']).toBe(false);
        expect(panel.getTextContent()).toContain('Open issue.');
        expect(panel.getTextContent()).not.toContain('Proposals only');

        const history = await renderScreen(
            <ReviewCommentsHistoryView comments={comments} labels={labels} />,
        );
        expect(history.getTextContent()).toContain('Resolved issue.');
        expect(history.getTextContent()).not.toContain('Open issue.');

        const header = await renderScreen(
            <ReviewCommentsHeaderButton
                unresolvedCount={2}
                expanded={false}
                labels={{ title: 'Review comments', count: ({ count }) => `${count}` }}
            />,
        );
        expect(header.getTextContent()).toContain('Review comments');
        expect(header.getTextContent()).toContain('2');
        // Before the comments are read the count is unknown: the row never claims "0".
        const unread = await renderScreen(
            <ReviewCommentsHeaderButton
                unresolvedCount={null}
                expanded={false}
                labels={{ title: 'Review comments', count: ({ count }) => `${count}` }}
            />,
        );
        expect(unread.getTextContent()).toContain('Review comments');
        expect(unread.getTextContent()).not.toMatch(/\d/);

    });

    it('shows deterministic partial failures for bulk transitions', async () => {
        const onBulkTransition = vi.fn();
        const screen = await renderScreen(
            <ReviewCommentsPanel
                comments={[
                    comment({ id: 'open-1', state: 'open', body: 'Open issue.' }),
                    comment({ id: 'proposed-1', state: 'proposed', body: 'Proposed issue.' }),
                ]}
                labels={labels}
                selectedStates={['open', 'proposed']}
                onBulkTransition={onBulkTransition}
                bulkTransitionResult={{
                    bulkActionId: 'bulk-1',
                    failed: [{ commentId: 'open-1', errorCode: 'permission_denied' }],
                }}
                testID="review-panel"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('review-panel-bulk-resolve'), 'review-panel-bulk-resolve');

        expect(onBulkTransition).toHaveBeenCalledWith({
            commentIds: ['open-1'],
            toState: 'resolved',
        });
        expect(screen.getTextContent()).toContain('Some comments were not updated');
        expect(screen.getTextContent()).toContain('open-1:permission_denied');
    });

    it('offers bulk Dismiss but no bulk Resolve when only proposals are visible', async () => {
        const onBulkTransition = vi.fn();
        const screen = await renderScreen(<ReviewCommentsPanel
            comments={[comment({ id: 'proposal', state: 'proposed' })]}
            labels={labels} onBulkTransition={onBulkTransition} testID="proposals" />);
        expect(screen.findByTestId('proposals-bulk-resolve')).toBeNull();
        await screen.pressByTestIdAsync('proposals-bulk-dismiss');
        expect(onBulkTransition).toHaveBeenCalledWith({ commentIds: ['proposal'], toState: 'dismissed' });
    });
});
