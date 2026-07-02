import type { ReviewCommentV1 } from '@happier-dev/protocol';

import type { ReviewCommentLabels } from '@/components/reviews/labels';

export function buildReviewCommentFixture(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    const id = overrides.id ?? 'comment-1';
    const state = overrides.state ?? 'open';
    return {
        v: 1,
        id,
        accountId: 'account-1',
        projectId: overrides.projectId ?? 'project-1',
        workspaceId: overrides.workspaceId,
        sessionId: overrides.sessionId,
        runId: overrides.runId,
        engineId: overrides.engineId,
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: overrides.snapshot ?? { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'Review comment body.',
        bodyVersion: overrides.bodyVersion ?? 1,
        edits: overrides.edits ?? [],
        author: overrides.author ?? { kind: 'plugin', pluginId: 'review-coderabbit' },
        state,
        flags: overrides.flags ?? {},
        dispositions: overrides.dispositions ?? {},
        parentCommentId: overrides.parentCommentId,
        threadId: overrides.threadId ?? id,
        evidence: overrides.evidence,
        transitions: overrides.transitions ?? [
            {
                transitionId: 'transition-1',
                toState: state,
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                serverRevision: 1,
            },
        ],
        tombstone: overrides.tombstone,
        fingerprint: overrides.fingerprint,
        linkedRefs: overrides.linkedRefs,
        suggestedFix: overrides.suggestedFix,
        createdAt: overrides.createdAt ?? 1,
        updatedAt: overrides.updatedAt ?? 1,
        serverRevision: overrides.serverRevision ?? 1,
        metadata: overrides.metadata,
    };
}

export const reviewCommentLabelsFixture = {
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
    states: {
        proposed: 'Proposed',
        open: 'Open',
        delegated: 'Delegated',
        pending_review: 'Pending review',
        resolved: 'Resolved',
        dismissed: 'Dismissed',
    },
} satisfies ReviewCommentLabels;
