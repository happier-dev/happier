import { describe, expect, it } from 'vitest';
import {
  projectReviewCommentStructuralMutationV1,
  deriveReviewCommentStructuralMutationV1,
  applyReviewCommentPreparedSensitiveMutationV1,
  ReviewCommentStructuralMutationV1Schema,
  ReviewCommentPrepareMutationResponseV1Schema,
  ReviewCommentCommitMutationResponseV1Schema,
} from './mutation.js';
import { splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1, openStoredReviewCommentV1 } from './content.js';

const actor = { kind: 'user' as const, userId: 'user-1' };
const input = {
  projectId: 'project-1', clientMutationId: 'mutation-1', authorIntent: 'open',
  anchor: { kind: 'workspace', workspaceId: 'workspace-1' },
  snapshot: { kind: 'none', capturedAt: 1000 }, body: 'private body',
  metadata: { taxonomyIds: ['private taxonomy'] },
};
const runtime = { now: () => 1000, createId: (prefix: string) => `${prefix}-1` };

describe('canonical Review Comment structural mutations', () => {
  it('uses the canonical Review error codes in both prepared and committed failures', () => {
    const failed = [{ commentId: 'missing-comment', errorCode: 'review_comment_not_found', error: 'Missing comment' }];
    const prepared = { v: 1, receipt: 'receipt', request: { v: 1,
      mutation: projectReviewCommentStructuralMutationV1('reviews.comments.create', input),
      contentCommitment: 'a'.repeat(43) }, records: [], replayed: false, failed };
    const committed = { v: 1, comments: [], replayed: false, failed };
    expect(ReviewCommentPrepareMutationResponseV1Schema.safeParse(prepared).success).toBe(true);
    expect(ReviewCommentCommitMutationResponseV1Schema.safeParse(committed).success).toBe(true);
    const unknownFailure = [{ ...failed[0], errorCode: 'external_unknown_error' }];
    expect(ReviewCommentPrepareMutationResponseV1Schema.safeParse({ ...prepared, failed: unknownFailure }).success).toBe(false);
    expect(ReviewCommentCommitMutationResponseV1Schema.safeParse({ ...committed, failed: unknownFailure }).success).toBe(false);
  });

  it('admits no sensitive create fields and reconstructs the server-assigned record for sealing', () => {
    const mutation = projectReviewCommentStructuralMutationV1('reviews.comments.create', input);
    expect(JSON.stringify(mutation)).not.toContain('private');
    expect(ReviewCommentStructuralMutationV1Schema.safeParse({ ...mutation, input: { ...mutation.input, anchorIndex: { kind: 'file', filePath: 'private.ts' } } }).success).toBe(false);
    const { projectId: _project, ...withoutScope } = mutation.input;
    expect(ReviewCommentStructuralMutationV1Schema.safeParse({ ...mutation, input: withoutScope }).success).toBe(false);
    const prepared = deriveReviewCommentStructuralMutationV1({ mutation, accountId: 'account-1', actor, current: [], runtime });
    const sensitive = applyReviewCommentPreparedSensitiveMutationV1({ mutation, input, prepared: prepared.records[0]!, previous: undefined });
    const stored = { v: 1 as const, structural: prepared.records[0]!.structural,
      sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ structural: prepared.records[0]!.structural, sensitive, mode: 'plain' }) };
    const opened = openStoredReviewCommentV1({ stored, mode: 'plain' });
    expect(opened.status).toBe('available');
    if (opened.status === 'available') expect(opened.comment).toMatchObject({ id: 'review-comment-1', body: 'private body', serverRevision: 1, author: actor });
  });

  it('requires evidence or reason for delegated and pending-review state changes', () => {
    const create = projectReviewCommentStructuralMutationV1('reviews.comments.create', input);
    const first = deriveReviewCommentStructuralMutationV1({ mutation: create, accountId: 'account-1', actor, current: [], runtime }).records[0]!;
    for (const toState of ['delegated', 'pending_review']) {
      const mutation = projectReviewCommentStructuralMutationV1('reviews.comments.transition', {
        projectId: 'project-1', commentId: first.structural.id, expectedState: 'open', expectedServerRevision: 1, toState, clientMutationId: `transition-${toState}`,
      });
      expect(() => deriveReviewCommentStructuralMutationV1({ mutation, accountId: 'account-1', actor, current: [first.structural], runtime })).toThrow();
    }
  });

  it('does not turn an external runtime error into a Review bulk failure', () => {
    const create = projectReviewCommentStructuralMutationV1('reviews.comments.create', input);
    const first = deriveReviewCommentStructuralMutationV1({ mutation: create, accountId: 'account-1', actor, current: [], runtime }).records[0]!;
    const mutation = projectReviewCommentStructuralMutationV1('reviews.comments.bulkTransition', {
      projectId: 'project-1', commentIds: [first.structural.id], expectedServerRevisions: { [first.structural.id]: 1 },
      expectedState: 'open', toState: 'dismissed', reason: 'No longer needed', clientMutationId: 'bulk-1', bulkActionId: 'bulk-action-1',
    });
    const externalError = Object.assign(new Error('ID source unavailable'), { code: 'EIO' });
    expect(() => deriveReviewCommentStructuralMutationV1({ mutation, accountId: 'account-1', actor, current: [first.structural],
      runtime: { now: runtime.now, createId: () => { throw externalError; } },
    })).toThrow(externalError);
  });

  it('derives an edit from admitted currentness and preserves private history for its revised binding', () => {
    const create = projectReviewCommentStructuralMutationV1('reviews.comments.create', input);
    const first = deriveReviewCommentStructuralMutationV1({ mutation: create, accountId: 'account-1', actor, current: [], runtime }).records[0]!;
    const initialSensitive = applyReviewCommentPreparedSensitiveMutationV1({ mutation: create, input, prepared: first });
    const opened = openStoredReviewCommentV1({ stored: { v: 1, structural: first.structural, sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ structural: first.structural, sensitive: initialSensitive, mode: 'plain' }) }, mode: 'plain' });
    if (opened.status !== 'available') throw new Error('fixture unavailable');
    const editInput = { projectId: 'project-1', commentId: first.structural.id, expectedServerRevision: 1, expectedBodyVersion: 1, nextBody: 'private revision', reason: 'private rationale', clientMutationId: 'edit-1' };
    const mutation = projectReviewCommentStructuralMutationV1('reviews.comments.edit', editInput);
    const edited = deriveReviewCommentStructuralMutationV1({ mutation, accountId: 'account-1', actor, current: [first.structural], runtime }).records[0]!;
    const sensitive = applyReviewCommentPreparedSensitiveMutationV1({ mutation, input: editInput, prepared: edited, previous: opened.comment });
    expect(edited.structural).toMatchObject({ serverRevision: 2, bodyVersion: 2 });
    expect(sensitive.edits).toEqual([expect.objectContaining({ previousBody: 'private body', nextBody: 'private revision', reason: 'private rationale' })]);
    expect(() => sealReviewCommentSensitiveEnvelopeV1({ structural: edited.structural, sensitive, mode: 'plain' })).not.toThrow();
    expect(() => deriveReviewCommentStructuralMutationV1({ mutation, accountId: 'account-1', actor, current: [{ ...first.structural, serverRevision: 2 }], runtime })).toThrow();
  });
});
