import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewCommentV1 } from '@happier-dev/protocol';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { ReviewCommentDirectWriteGrantSheet } from './ReviewCommentDirectWriteGrantSheet';
import { ReviewCommentsHeaderButton } from './ReviewCommentsHeaderButton';
import { ReviewCommentsHistoryView } from './ReviewCommentsHistoryView';
import { ReviewCommentsPanel } from './ReviewCommentsPanel';

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

const labels = {
    empty: 'No comments',
    directWriteGranted: 'Direct write enabled',
    directWriteMissing: 'Proposals only',
    engine: 'Engine',
    stale: 'Stale',
    outdated: 'Outdated',
    binarySnapshot: 'Binary snapshot',
    minified: 'Likely minified',
    submoduleSnapshot: 'Submodule snapshot',
    symlinkSnapshot: 'Symlink snapshot',
    textSnapshot: 'Text snapshot',
    tooLargeSnapshot: 'Snapshot too large',
    encryptedSnapshot: 'Encrypted snapshot',
    truncated: 'Truncated',
    bidiControls: 'Bidi controls',
    redacted: 'Redacted',
    contentUnavailable: 'Content unavailable',
    edit: 'Edit',
    resolve: 'Resolve',
    dismiss: 'Dismiss',
    reopen: 'Reopen',
    redact: 'Redact',
    reply: 'Reply',
    replyUnavailable: 'Reply unavailable',
    bulkResolve: 'Resolve visible',
    bulkDismiss: 'Dismiss visible',
    bulkPartialFailure: 'Some comments were not updated',
    bulkFailure: ({ commentId, errorCode }: Readonly<{ commentId: string; errorCode: string }>) =>
        `${commentId}:${errorCode}`,
    filtersTitle: 'Filters',
    states: {
        proposed: 'Proposed',
        open: 'Open',
        delegated: 'Delegated',
        pending_review: 'Pending review',
        resolved: 'Resolved',
        dismissed: 'Dismissed',
    },
};

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
                directWriteGranted={false}
                selectedStates={['open']}
            />,
        );
        expect(panel.getTextContent()).toContain('Filters');
        expect(panel.getTextContent()).toContain('Open issue.');
        expect(panel.getTextContent()).toContain('Proposals only');

        const history = await renderScreen(
            <ReviewCommentsHistoryView comments={comments} labels={labels} directWriteGranted={true} />,
        );
        expect(history.getTextContent()).toContain('Resolved issue.');
        expect(history.getTextContent()).not.toContain('Open issue.');

        const header = await renderScreen(
            <ReviewCommentsHeaderButton
                unresolvedCount={2}
                labels={{ title: 'Review comments', count: ({ count }) => `${count}` }}
            />,
        );
        expect(header.getTextContent()).toContain('Review comments');
        expect(header.getTextContent()).toContain('2');

        const onGrant = vi.fn();
        const onCancel = vi.fn();
        const grant = await renderScreen(
            <ReviewCommentDirectWriteGrantSheet
                pendingRequest={{
                    v: 1,
                    id: 'request-1',
                    accountId: 'account-1',
                    pluginId: 'review-coderabbit',
                    pluginName: 'CodeRabbit',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
                    requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
                    authoritySource: { kind: 'bundled' },
                    reason: 'Write approved comments.',
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }}
                labels={{
                    title: 'Direct write',
                    body: ({ pluginName, pluginId }) => `${pluginName}:${pluginId}`,
                    grant: 'Grant',
                    cancel: 'Cancel',
                }}
                onGrant={onGrant}
                onCancel={onCancel}
            />,
        );
        expect(grant.getTextContent()).toContain('review-coderabbit');
        expect(grant.getTextContent()).toContain('Grant');
        expect(onGrant).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();
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
                directWriteGranted
                selectedStates={['open', 'proposed']}
                onBulkTransition={onBulkTransition}
                bulkTransitionResult={{
                    bulkActionId: 'bulk-1',
                    failed: [{ commentId: 'proposed-1', errorCode: 'permission_denied' }],
                }}
                testID="review-panel"
            />,
        );

        await pressTestInstanceAsync(screen.findByTestId('review-panel-bulk-resolve'), 'review-panel-bulk-resolve');

        expect(onBulkTransition).toHaveBeenCalledWith({
            commentIds: ['open-1', 'proposed-1'],
            toState: 'resolved',
        });
        expect(screen.getTextContent()).toContain('Some comments were not updated');
        expect(screen.getTextContent()).toContain('proposed-1:permission_denied');
    });
});
