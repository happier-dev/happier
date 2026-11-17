import { describe, expect, it } from 'vitest';
import { openReviewVerdictContentV1, projectReviewNeedsYouV1 } from './reviewHumanV1.js';

describe('Review human attention', () => {
  const input = {
    reviewId: 'review', roundOrdinal: 2, actorAccountId: 'alice', canRead: true, canDecide: true,
    pendingDecisionCount: 2,
    requests: [{ roundOrdinal: 2, eligibleAccountIds: ['alice', 'bob'] }, { roundOrdinal: 2, eligibleAccountIds: ['alice'] }],
    verdicts: [{ roundOrdinal: 1, accountId: 'alice' }],
  };

  it('joins finding decisions and renewed requests under one stable Review reason', () => {
    const pending = projectReviewNeedsYouV1(input);
    expect(pending).toMatchObject({ needsYou: true, requestedVerdict: true, pendingDecisions: true, canSubmitVerdict: true });
    const teamSatisfied = projectReviewNeedsYouV1({ ...input, pendingDecisionCount: 0,
      verdicts: [...input.verdicts, { roundOrdinal: 2, accountId: 'bob' }] });
    expect(teamSatisfied).toMatchObject({ reason: pending.reason, needsYou: true, requestedVerdict: true, pendingDecisions: false });
    const resolved = projectReviewNeedsYouV1({ ...input, pendingDecisionCount: 0,
      verdicts: [{ roundOrdinal: 2, accountId: 'alice' }] });
    expect(resolved).toMatchObject({ reason: pending.reason, needsYou: false, requestedVerdict: false, canSubmitVerdict: true });
  });

  it('does not disclose attention without access or give a View reader finding decisions', () => {
    expect(projectReviewNeedsYouV1({ ...input, canRead: false })).toMatchObject({
      needsYou: false, requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false,
    });
    expect(projectReviewNeedsYouV1({ ...input, canDecide: false, requests: [] })).toMatchObject({
      needsYou: false, requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false,
    });
    expect(projectReviewNeedsYouV1({ ...input, canDecide: false })).toMatchObject({
      needsYou: true, requestedVerdict: true, pendingDecisions: false, canSubmitVerdict: true,
    });
  });

  it('rejects verdict prose replayed across Review, round, person or revision', async () => {
    const payload = { reviewId: 'review', roundOrdinal: 2, accountId: 'alice', revision: 1, body: 'Ready to merge' };
    const open = async () => payload;
    const content = { t: 'encrypted' as const, c: 'artifact-key-ciphertext' };
    await expect(openReviewVerdictContentV1({ content, expected: payload, open })).resolves.toEqual(payload);
    for (const change of [{ reviewId: 'another' }, { roundOrdinal: 3 }, { accountId: 'bob' }, { revision: 2 }]) {
      await expect(openReviewVerdictContentV1({ content, expected: { ...payload, ...change }, open }))
        .rejects.toMatchObject({ code: 'review_verdict_content_mismatch' });
    }
  });

});
