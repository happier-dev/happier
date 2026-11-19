import { describe, expect, it } from 'vitest';
import * as protocol from '../index.js';
import { buildAcceptedReviewFindingsForVerifyV1 } from './reviewFindingsApplyInputV1.js';
import { buildReviewTriageTransitionRequestV1 } from './comments/triageTransition.js';
import type { ReviewCommentV1 } from './comments/v1.js';
import type { ReviewFinding } from './ReviewFinding.js';

type ApplyApi = {
  REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1: string;
  REVIEW_FINDINGS_VERIFY_ONLY_INSTRUCTIONS_V1: string;
  renderReviewFindingsForVerifyV1: (findings: readonly ReviewFinding[]) => string;
};

describe('review findings verification input', () => {
  it('preserves evidence, attribution, and the durable CAS reference as labelled data', () => {
    const api = protocol as typeof protocol & Partial<ApplyApi>;
    expect(api.renderReviewFindingsForVerifyV1).toBeTypeOf('function');
    if (!api.renderReviewFindingsForVerifyV1) return;
    const finding = {
      id: 'f1', title: 'Unsafe read', severity: 'high' as const, category: 'correctness' as const,
      summary: 'Missing null check', evidence: 'reader.ts dereferences null',
      filePath: 'src/reader.ts', startLine: 20, confidence: 0.6,
      attributionConfidence: 'uncertain', threadRefs: ['thread-1'],
      comment: { id: 'comment-1', workspace: { machineId: 'machine-1', path: '/repo' }, serverRevision: 7, state: 'open' as const },
    };
    const text = api.renderReviewFindingsForVerifyV1([finding]);
    const data = JSON.parse(text.slice(text.indexOf('[')));
    expect(data).toEqual([expect.objectContaining({
      id: 'f1', evidence: finding.evidence, confidence: 0.6, attributionConfidence: 'uncertain', threadRefs: ['thread-1'],
      comment: { commentId: 'comment-1', workspace: finding.comment.workspace, expectedServerRevision: 7, expectedState: 'open' },
    })]);
  });
});

it('excludes dismissed roots with retained acceptance from Apply until deliberately reopened, preserving resolved acceptance', () => {
  const finding = { id: 'finding-1', title: 'Total subtracts prices', summary: 'The reducer subtracts instead of adding.' };
  const comment: ReviewCommentV1 = {
    v: 1, id: 'comment-1', accountId: 'account-1', reviewId: 'review-1',
    findingIdentity: 'a'.repeat(64), findingId: finding.id, runId: 'run-1',
    anchor: { kind: 'workspace', workspaceId: 'workspace-1' }, snapshot: { kind: 'none', capturedAt: 1 },
    body: 'Evidence remains readable after dismissal', bodyVersion: 1, edits: [], author: { kind: 'user', userId: 'user-1' },
    state: 'open', reviewTriageStatus: 'accept', flags: {}, dispositions: {}, threadId: 'comment-1',
    transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 3,
  };
  const reviews = [{ runId: 'run-1', findings: [finding] }];
  const accepted = (current: ReviewCommentV1) => buildAcceptedReviewFindingsForVerifyV1(reviews, [current]);
  expect(accepted(comment).map(item => item.id)).toEqual([finding.id]);
  const dismissed = { ...comment, state: 'dismissed' as const, serverRevision: 5 };
  expect(accepted(dismissed)).toEqual([]);
  expect(accepted({ ...comment, state: 'resolved' }).map(item => item.id)).toEqual([finding.id]);
  const reopen = buildReviewTriageTransitionRequestV1({ comment: dismissed, decision: 'accept', clientMutationId: 'reopen' });
  expect(reopen).toMatchObject({ expectedState: 'dismissed', expectedServerRevision: 5, toState: 'open', reviewTriageStatus: 'accept' });
  expect(accepted({ ...dismissed, state: reopen.toState, reviewTriageStatus: reopen.reviewTriageStatus }).map(item => item.id)).toEqual([finding.id]);
});
