import { describe, expect, it } from 'vitest';

import { resolveReviewRunContinuityV1 } from './reviewRoundActionsV1.js';

describe('native Review round continuity', () => {
  it('uses the host lifecycle for bounded continuation and refuses absent recovery evidence', () => {
    const run = { status: 'succeeded', retentionPolicy: 'resumable',
      lifecycle: { v: 1, state: 'recoverable_with_input' } } as const;
    expect(resolveReviewRunContinuityV1(run, { kind: 'new_round' }))
      .toEqual({ ok: true, continuity: 'continues' });
    expect(resolveReviewRunContinuityV1({ ...run, lifecycle: undefined }, { kind: 'new_round' }))
      .toMatchObject({ ok: false, errorCode: 'review_follow_up_resume_unavailable' });
  });

  it('requires an explicit fresh choice after an ended retained review', () => {
    const run = { status: 'failed', retentionPolicy: 'resumable',
      lifecycle: { v: 1, state: 'unavailable' } } as const;
    expect(resolveReviewRunContinuityV1(run, { kind: 'new_round' }))
      .toMatchObject({ ok: false, errorCode: 'review_follow_up_ended' });
    expect(resolveReviewRunContinuityV1(run, { kind: 'new_round', fresh: true }))
      .toEqual({ ok: true, continuity: 'fresh' });
  });

  it('starts ephemeral reviewers fresh while preserving the retained follow-up requirement', () => {
    const run = { status: 'succeeded', retentionPolicy: 'ephemeral',
      lifecycle: { v: 1, state: 'unavailable' } } as const;
    expect(resolveReviewRunContinuityV1(run, { kind: 'new_round' }))
      .toEqual({ ok: true, continuity: 'fresh' });
    expect(resolveReviewRunContinuityV1(run, { kind: 'follow_up' }))
      .toMatchObject({ ok: false, errorCode: 'review_follow_up_not_resumable' });
  });
});
