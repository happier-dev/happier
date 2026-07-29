import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewCommentV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';

import { ReviewCommentsList } from './ReviewCommentsList';

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
    engine: 'Engine',
    stale: 'Stale',
    outdated: 'Outdated',
    binarySnapshot: 'Binary snapshot',
    minified: 'Likely minified',
    submoduleSnapshot: 'Submodule snapshot',
    symlinkSnapshot: 'Symlink snapshot',
    tooLargeSnapshot: 'Snapshot too large',
    encryptedSnapshot: 'Encrypted snapshot',
    truncated: 'Truncated',
    bidiControls: 'Bidi controls',
    textSnapshot: 'Text snapshot',
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
    states: {
        proposed: 'Proposed',
        open: 'Open',
        delegated: 'Delegated',
        pending_review: 'Pending review',
        resolved: 'Resolved',
        dismissed: 'Dismissed',
    },
};

describe('ReviewCommentsList', () => {
    it('renders durable comments and redacted history state', async () => {
        const screen = await renderScreen(
            <ReviewCommentsList
                comments={[
                    comment({ id: 'c1', state: 'open', body: 'Fix this.', engineId: 'review-deepsec', flags: { stale: true } }),
                    comment({ id: 'c2', state: 'resolved', body: '', flags: { redacted: true } }),
                ]}
                labels={labels}
            />,
        );

        expect(screen.getTextContent()).toContain('Fix this.');
        expect(screen.getTextContent()).toContain('Open');
        expect(screen.getTextContent()).toContain('review-deepsec');
        expect(screen.getTextContent()).toContain('Stale');
        expect(screen.getTextContent()).toContain('Redacted');
        expect(screen.getTextContent()).not.toContain('Proposals only');
        expect(screen.getTextContent()).not.toContain('Direct write enabled');
    });
});
