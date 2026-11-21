import { describe, expect, it } from 'vitest';
import {
  REVIEW_TRIAGE_SOURCE_V1,
  reviewTriageLocalRefV1,
} from '@happier-dev/triage-protocol/v1';
import { getReviewV1 } from './source.js';

type Facts = Readonly<{
  needsYou: boolean;
  requestedVerdict: boolean;
  pendingDecisions: boolean;
}>;

// Host Actions are the transport boundary; the real source projects the Review owner's facts.
function context(facts: Facts) {
  return {
    signal: new AbortController().signal,
    services: {
      actions: {
        execute: async (id: string) => {
          if (id === 'artifact.list')
            return {
              items: [
                {
                  artifactId: 'review-a',
                  ownerAccountId: 'owner',
                  header: { title: 'Fix settings modal remount' },
                },
              ],
            };
          return {
            review: {
              reviewId: 'review-a',
              createdAt: 1,
              updatedAt: 2,
              subjectKind: 'pull_request',
            },
            human: {
              needsYou: {
                reviewId: 'review-a',
                roundOrdinal: 1,
                reason: 'review_needs_you',
                canSubmitVerdict: true,
                ...facts,
              },
            },
          };
        },
      },
    },
  } as unknown as Parameters<typeof getReviewV1>[1];
}
const read = (facts: Facts) =>
  getReviewV1(
    { v: 1, localRef: reviewTriageLocalRefV1('review-a') } as Parameters<
      typeof getReviewV1
    >[0],
    context(facts),
  );

describe('Review observation', () => {
  it('names the Review by its subject and place, never its raw id', async () => {
    const result = await read({
      needsYou: true,
      requestedVerdict: true,
      pendingDecisions: false,
    });
    if (result.kind !== 'present') throw new Error('expected a present Review');
    expect(result.snapshot.title).toBe('Fix settings modal remount');
    expect(result.locator.displayPath).not.toContain('review-a');
    expect(result.locator.routingToken).toBe('review-a');
    expect(REVIEW_TRIAGE_SOURCE_V1.localId).toBe('reviews');
  });

  it('says a requested verdict the way every requested review is said, from the same Review fact', async () => {
    const result = await read({
      needsYou: true,
      requestedVerdict: true,
      pendingDecisions: true,
    });
    if (result.kind !== 'present') throw new Error('expected a present Review');
    expect(result.viewer.involvement).toEqual(['reviewRequested']);
    expect(result.viewer.sourceAttention).toBeUndefined();
  });

  it('says a pending decision without a request as a decision', async () => {
    const result = await read({
      needsYou: true,
      requestedVerdict: false,
      pendingDecisions: true,
    });
    if (result.kind !== 'present') throw new Error('expected a present Review');
    expect(result.viewer.involvement).toEqual([]);
    expect(result.viewer.sourceAttention).toMatchObject({
      level: 'required',
      reasonLabel: 'Needs your decision',
    });
  });

  it('keeps a settled Review quiet', async () => {
    const result = await read({
      needsYou: false,
      requestedVerdict: false,
      pendingDecisions: false,
    });
    if (result.kind !== 'present') throw new Error('expected a present Review');
    expect(result.viewer).toMatchObject({
      involvement: [],
      sourceAttention: { level: 'none' },
    });
  });
});
