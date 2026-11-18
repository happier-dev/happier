import { describe, expect, it } from 'vitest';

import * as comments from './index.js';
import { ReviewCommentTransitionRequestV1Schema, type ReviewCommentStateV1, type ReviewCommentV1 } from './v1.js';
import type { ReviewTriageStatus } from '../reviewTriageStatus.js';

type TriageApi = {
  buildReviewTriageTransitionRequestV1: (params: Readonly<{
    comment: Pick<ReviewCommentV1, 'id' | 'state' | 'serverRevision' | 'projectId' | 'workspace'>;
    decision: ReviewTriageStatus;
    note?: string;
    clientMutationId: string;
  }>) => unknown;
};

function request(state: ReviewCommentStateV1, decision: ReviewTriageStatus, note?: string) {
  const api = comments as typeof comments & Partial<TriageApi>;
  expect(typeof api.buildReviewTriageTransitionRequestV1).toBe('function');
  const built = api.buildReviewTriageTransitionRequestV1!({
    comment: { id: 'c1', state, serverRevision: 4, workspace: { machineId: 'm1', path: '/repo' } },
    decision,
    ...(note ? { note } : {}),
    clientMutationId: 'mutation-1',
  });
  // Every request the owner builds must be one the canonical schema (and so the server) accepts.
  return ReviewCommentTransitionRequestV1Schema.parse(built);
}

describe('review finding decisions as ReviewComment transitions', () => {
  it('keeps native Review scope when deciding a comment without a legacy project or workspace', () => {
    const comment = { id: 'shared-comment', reviewId: 'review-1', state: 'proposed' as const, serverRevision: 4 };
    const built = comments.buildReviewTriageTransitionRequestV1({ comment, decision: 'accept', clientMutationId: 'native-decision' });
    expect(ReviewCommentTransitionRequestV1Schema.parse(built)).toMatchObject({ reviewId: 'review-1',
      commentId: 'shared-comment', expectedServerRevision: 4, toState: 'open' });
  });
  it('opens a proposed finding when it is chosen to be fixed, and reopens an ignored one', () => {
    expect(request('proposed', 'accept')).toMatchObject({ toState: 'open', expectedState: 'proposed', reviewTriageStatus: 'accept' });
    expect(request('dismissed', 'accept')).toMatchObject({ toState: 'open', expectedState: 'dismissed', reviewTriageStatus: 'accept' });
    expect(request('open', 'accept')).toMatchObject({ toState: 'open', reviewTriageStatus: 'accept' });
  });

  it('dismisses an ignored finding with a reason, but never reopens or re-dismisses a settled one', () => {
    const ignored = request('open', 'reject');
    expect(ignored).toMatchObject({ toState: 'dismissed', reviewTriageStatus: 'reject' });
    expect(ignored.reason).toBeTruthy();
    expect(request('proposed', 'reject', 'Out of scope')).toMatchObject({ toState: 'dismissed', reason: 'Out of scope' });
    expect(request('resolved', 'reject')).toMatchObject({ toState: 'resolved', reviewTriageStatus: 'reject' });
    expect(request('dismissed', 'reject')).toMatchObject({ toState: 'dismissed', reviewTriageStatus: 'reject' });
  });

  it('keeps the state for Decide later and carries the CAS fields of the current comment', () => {
    expect(request('proposed', 'defer')).toMatchObject({
      commentId: 'c1',
      toState: 'proposed',
      expectedState: 'proposed',
      expectedServerRevision: 4,
      workspace: { machineId: 'm1', path: '/repo' },
      reviewTriageStatus: 'defer',
      clientMutationId: 'mutation-1',
    });
  });
});
