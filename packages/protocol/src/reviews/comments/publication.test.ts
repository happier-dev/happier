import { describe, expect, it } from 'vitest';

import {
  ReviewCommentPublicationPlanV1Schema,
  formatReviewCommentPublicationMarkerV1,
  matchReviewCommentPublicationMarkerV1,
  preflightReviewCommentPublicationRoutingV1,
  reviewCommentPublicationTargetMatchesV1,
  validateReviewCommentPublicationClaimAgainstPlanV1,
  validateReviewCommentPublicationResultAgainstPlanV1,
} from '../../index.js';
import type {
  ReviewCommentPublicationEntryResultV1,
  ReviewCommentPublicationResultV1,
  ReviewCommentPublicationVerdictResultV1,
} from '../../index.js';

const correlation = (character: string) => character.repeat(43);

function publicationEntry(happierCommentId: string) {
  return {
    happierCommentId,
    expectedServerRevision: 1,
    anchor: { kind: 'line' as const, filePath: 'src/example.ts', line: 4 },
    snapshot: {
      kind: 'text' as const,
      selectedLines: ['return value;'],
      beforeContext: [],
      afterContext: [],
      selectedLinesHash: 'selected',
      contextWindowHash: 'context',
      capturedAt: 1,
      fileLength: 1,
      source: 'committed' as const,
      isUncommitted: false,
      isUntracked: false,
      truncated: false,
      hasBidiControls: false,
      likelyMinified: false,
    },
    body: `body-${happierCommentId}`,
  };
}

const target = {
  providerId: 'github',
  configuredAccountId: 'github-account-1',
  entryRef: {
    sourceId: 'github',
    kindId: 'pull-request',
    collisionScope: 'github:repository-1',
    entryId: '42',
  },
  subtarget: null,
};

describe('review comment publication contract', () => {
  it('owns exact marker formatting and target/subtarget routing once', () => {
    expect(formatReviewCommentPublicationMarkerV1('entry', correlation('a')))
      .toBe(`<!-- happier-review-comment:v1:${correlation('a')} -->`);
    expect(formatReviewCommentPublicationMarkerV1('verdict', correlation('v')))
      .toBe(`<!-- happier-review-verdict:v1:${correlation('v')} -->`);
    const marker = formatReviewCommentPublicationMarkerV1('entry', correlation('a'));
    expect(matchReviewCommentPublicationMarkerV1([
      { externalRef: 'native-1', body: `landed ${marker}` },
      { externalRef: 'native-2', body: `copied ${marker}` },
    ], marker)).toEqual({ kind: 'duplicate' });

    const expected = {
      providerId: 'github',
      configuredAccountId: 'github-account-1',
      sourceId: 'github',
      localRef: target.entryRef,
      subtarget: null,
    } as const;
    expect(reviewCommentPublicationTargetMatchesV1(target, expected)).toBe(true);
    expect(reviewCommentPublicationTargetMatchesV1(
      { ...target, subtarget: { kindId: 'review-thread', targetId: 'thread-1' } },
      expected,
    )).toBe(false);
    expect(reviewCommentPublicationTargetMatchesV1(
      { ...target, subtarget: { kindId: 'review-thread', targetId: 'thread-1' } },
      { ...expected, subtarget: { kindId: 'review-thread', targetId: 'thread-1' } },
    )).toBe(true);
  });

  it('freezes unique canonical entries and a separate nullable verdict', () => {
    expect(ReviewCommentPublicationPlanV1Schema.safeParse({
      target,
      baseRevision: 'base-1',
      headRevision: 'head-1',
      entries: [publicationEntry('comment-1'), publicationEntry('comment-1')],
      verdict: null,
    }).success).toBe(false);

    expect(ReviewCommentPublicationPlanV1Schema.safeParse({
      target: { ...target, subtarget: { kindId: 'repository', targetId: 'wrong-domain' } },
      baseRevision: null,
      headRevision: null,
      entries: [publicationEntry('comment-1')],
      verdict: null,
    }).success).toBe(false);

    expect(ReviewCommentPublicationPlanV1Schema.safeParse({
      target,
      baseRevision: 'base-1',
      headRevision: 'head-1',
      entries: [],
      verdict: null,
    }).success).toBe(false);

    expect(ReviewCommentPublicationPlanV1Schema.safeParse({
      target,
      baseRevision: 'base-1',
      headRevision: 'head-1',
      entries: [],
      verdict: { kind: 'approve', body: 'Looks good.' },
    }).success).toBe(true);

    expect(ReviewCommentPublicationPlanV1Schema.safeParse({
      target,
      baseRevision: null,
      headRevision: null,
      entries: [publicationEntry('issue-comment-1')],
      verdict: null,
    }).success).toBe(true);

    expect(ReviewCommentPublicationPlanV1Schema.safeParse({
      target,
      baseRevision: 'base-1',
      headRevision: null,
      entries: [publicationEntry('comment-1')],
      verdict: null,
    }).success).toBe(false);

    expect(ReviewCommentPublicationPlanV1Schema.safeParse({
      target,
      baseRevision: null,
      headRevision: null,
      entries: [],
      verdict: { kind: 'approve', body: 'Looks good.' },
    }).success).toBe(false);
  });

  it('rejects missing, extra, reordered, or invented publication correlations', () => {
    const plan = ReviewCommentPublicationPlanV1Schema.parse({
      target,
      baseRevision: 'base-1',
      headRevision: 'head-1',
      entries: [publicationEntry('comment-1'), publicationEntry('comment-2')],
      verdict: { kind: 'requestChanges', body: 'Please address both findings.' },
    });
    const claim = {
      disposition: 'dispatch' as const,
      publicationPlanId: correlation('p'),
      entries: [
        { happierCommentId: 'comment-1', publicationCorrelationId: correlation('a') },
        { happierCommentId: 'comment-2', publicationCorrelationId: correlation('b') },
      ],
      verdict: { publicationCorrelationId: correlation('v') },
    };
    const publishedEntry: ReviewCommentPublicationEntryResultV1 = {
      happierCommentId: 'comment-1',
      publicationCorrelationId: correlation('a'),
      outcome: { kind: 'published', externalRef: 'native-comment-1' },
    };
    const publishedVerdict: ReviewCommentPublicationVerdictResultV1 = {
      publicationCorrelationId: correlation('v'),
      outcome: { kind: 'published', externalRef: 'native-review-1' },
    };
    const typedResult: ReviewCommentPublicationResultV1 = {
      publicationPlanId: claim.publicationPlanId,
      entries: [
        publishedEntry,
        {
          happierCommentId: 'comment-2',
          publicationCorrelationId: correlation('b'),
          outcome: { kind: 'uncertain' },
        },
      ],
      verdict: publishedVerdict,
    };

    expect(validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, typedResult))
      .toEqual(typedResult);

    expect(() => validateReviewCommentPublicationClaimAgainstPlanV1(plan, {
      ...claim,
      entries: claim.entries.slice(0, 1),
    })).toThrow('review_comment_publication_claim_cardinality_mismatch');

    expect(() => validateReviewCommentPublicationClaimAgainstPlanV1(plan, {
      ...claim,
      entries: [
        claim.entries[0],
        { ...claim.entries[1], publicationCorrelationId: claim.entries[0].publicationCorrelationId },
      ],
    })).toThrow('review_comment_publication_claim_cardinality_mismatch');

    expect(() => validateReviewCommentPublicationClaimAgainstPlanV1(plan, {
      ...claim,
      verdict: { publicationCorrelationId: claim.entries[0].publicationCorrelationId },
    })).toThrow('review_comment_publication_claim_cardinality_mismatch');

    expect(() => validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: [
        {
          happierCommentId: 'comment-2',
          publicationCorrelationId: correlation('b'),
          outcome: { kind: 'published', externalRef: 'native-comment-2' },
        },
        {
          happierCommentId: 'comment-1',
          publicationCorrelationId: correlation('a'),
          outcome: { kind: 'uncertain' },
        },
      ],
      verdict: {
        publicationCorrelationId: correlation('v'),
        outcome: { kind: 'published', externalRef: 'native-review-1' },
      },
    })).toThrow('review_comment_publication_result_cardinality_mismatch');

    expect(validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: claim.entries.map((entry) => ({
        ...entry,
        outcome: { kind: 'published', externalRef: `native-${entry.happierCommentId}` },
      })),
      verdict: {
        publicationCorrelationId: correlation('v'),
        outcome: { kind: 'published' },
      },
    }).verdict).toEqual({
      publicationCorrelationId: correlation('v'),
      outcome: { kind: 'published' },
    });

    expect(validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: claim.entries.map((entry) => ({
        ...entry,
        outcome: { kind: 'published', externalRef: `native-${entry.happierCommentId}` },
      })),
      verdict: {
        publicationCorrelationId: correlation('v'),
        outcome: { kind: 'uncertain', externalRef: 'published-summary-1' },
      },
    }).verdict).toMatchObject({ outcome: { kind: 'uncertain', externalRef: 'published-summary-1' } });
  });

  it('routes diff-less entries through the real verdict summary before claim', () => {
    const diffLessEntry = {
      ...publicationEntry('comment-summary'),
      anchor: { kind: 'workspace' as const, workspaceId: 'workspace-1' },
    };
    const withoutVerdict = ReviewCommentPublicationPlanV1Schema.parse({
      target,
      baseRevision: 'base-1',
      headRevision: 'head-1',
      entries: [publicationEntry('comment-inline'), diffLessEntry],
      verdict: null,
    });
    expect(preflightReviewCommentPublicationRoutingV1(withoutVerdict)).toEqual({
      kind: 'rejected',
      reason: 'diff_less_entry_requires_verdict_summary',
      entryIndexes: [1],
    });

    const withVerdict = ReviewCommentPublicationPlanV1Schema.parse({
      ...withoutVerdict,
      verdict: { kind: 'comment', body: 'Review summary.' },
    });
    expect(preflightReviewCommentPublicationRoutingV1(withVerdict)).toEqual({
      kind: 'ready',
      inlineEntryIndexes: [0],
      verdictSummaryEntryIndexes: [1],
    });

    const claim = {
      disposition: 'dispatch' as const,
      publicationPlanId: correlation('p'),
      entries: [
        { happierCommentId: 'comment-inline', publicationCorrelationId: correlation('a') },
        { happierCommentId: 'comment-summary', publicationCorrelationId: correlation('b') },
      ],
      verdict: { publicationCorrelationId: correlation('v') },
    };
    expect(validateReviewCommentPublicationResultAgainstPlanV1(withVerdict, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: [
        { ...claim.entries[0], outcome: { kind: 'published', externalRef: 'native-inline-1' } },
        { ...claim.entries[1], outcome: { kind: 'published', externalRef: 'native-summary-1' } },
      ],
      verdict: {
        publicationCorrelationId: correlation('v'),
        outcome: { kind: 'published', externalRef: 'native-summary-1' },
      },
    })).toMatchObject({
      entries: [
        { outcome: { externalRef: 'native-inline-1' } },
        { outcome: { externalRef: 'native-summary-1' } },
      ],
      verdict: { outcome: { externalRef: 'native-summary-1' } },
    });
    expect(() => validateReviewCommentPublicationResultAgainstPlanV1(withVerdict, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: [
        { ...claim.entries[0], outcome: { kind: 'published', externalRef: 'native-inline-1' } },
        { ...claim.entries[1], outcome: { kind: 'published', externalRef: 'wrong-summary' } },
      ],
      verdict: {
        publicationCorrelationId: correlation('v'),
        outcome: { kind: 'published', externalRef: 'native-summary-1' },
      },
    })).toThrow('review_comment_publication_result_summary_reference_mismatch');
  });
});
