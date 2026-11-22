import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
  createSessionFilesViewFixture,
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture:
  | Awaited<ReturnType<typeof createSessionFilesViewFixture>>
  | undefined;
afterEach(async () => {
  standardCleanup();
  await fixture?.dispose();
  fixture = undefined;
});

/** A completed round whose three model reviewers each recorded a 1–5 score and its reason. */
function reviewArtifact(serverId: string, state: 'completed' | 'partial'): DecryptedArtifact {
  const rounds = [
    {
      ordinal: 1,
      state,
      startedAt: 1,
      finishedAt: 2,
      reviewerIds: [
        'step-1-reviewer-1',
        'step-1-reviewer-2',
        'step-1-reviewer-3',
      ],
      runs: [],
      reviewerQuality: [
        {
          reviewerId: 'step-1-reviewer-1',
          displayName: 'Codex',
          score: 4,
          rationale: 'Clean backoff with a cap and a give-up path.',
        },
        {
          reviewerId: 'step-1-reviewer-2',
          score: 2,
          rationale: 'The jitter clamp is untested.',
        },
        {
          reviewerId: 'step-1-reviewer-3',
          score: 3,
          rationale: 'Sound backoff; one retry can pass 2 s.',
        },
      ],
    },
  ];
  return {
    id: 'review-quality',
    sourceServerId: serverId,
    title: 'Retry reconnect with backoff',
    isDecrypted: true,
    header: {
      kind: 'review.v1',
      v: 1,
      reviewId: 'review-quality',
      title: 'Retry reconnect with backoff',
    },
    body: JSON.stringify({ v: 1, rounds }),
    ownerAccountId: 'alice',
    access: 'owner',
    storageMode: 'plain',
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function renderReview(
  settings?: Readonly<{ reviewQualityAggregation: 'lowest' | 'median' }>,
  state: 'completed' | 'partial' = 'completed',
) {
  fixture = await createSessionFilesViewFixture({
    serverUrl: 'https://review-quality.test',
    settings,
  });
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  return await fixture.render(
    <ReviewDetailHost
      artifact={reviewArtifact(fixture.scope.serverId, state)}
      bodyState="ready"
      onRetry={() => {}}
    />,
  );
}

function textOf(
  screen: Awaited<ReturnType<typeof renderReview>>,
  testID: string,
): string {
  const node = screen.findByTestId(testID);
  return node
    ? node
        .findAll((child) => typeof child.type === 'string')
        .flatMap((child) => child.children)
        .filter((child): child is string => typeof child === 'string')
        .join('')
    : '';
}

it("shows the recorded score the Host combined with the person's setting, and says which", async () => {
  const lowest = await renderReview();
  try {
    await vi.waitFor(() =>
      expect(lowest.findByTestId('review-detail:quality-score')).not.toBeNull(),
    );
    expect(textOf(lowest, 'review-detail:quality-score')).toBe('Quality 2/5');
    expect(textOf(lowest, 'review-detail:quality-basis')).toBe(
      'Lowest of 3 reviewers',
    );
    // The reasons sit one press away (UI refinements 2026-11-20): the line itself stays quiet.
    expect(textOf(lowest, 'review-detail:quality')).not.toContain('The jitter clamp is untested.');
    expect(
      lowest.findByTestId('review-detail:quality-reviewer:step-1-reviewer-1'),
    ).toBeNull();
    await lowest.pressByTestIdAsync('review-detail:quality-each');
    expect(textOf(lowest, 'review-detail:quality')).toContain('The jitter clamp is untested.');
    expect(
      lowest.findByTestId('review-detail:quality-reviewer:step-1-reviewer-1'),
    ).not.toBeNull();
  } finally {
    await lowest.unmount();
  }
  standardCleanup();
  await fixture?.dispose();
  fixture = undefined;
  const median = await renderReview({ reviewQualityAggregation: 'median' });
  try {
    await vi.waitFor(() =>
      expect(textOf(median, 'review-detail:quality-score')).toBe('Quality 3/5'),
    );
    expect(textOf(median, 'review-detail:quality-basis')).toBe(
      'Median of 3 reviewers',
    );
  } finally {
    await median.unmount();
  }
});


it('passes partial-round score evidence and the typed reason through the mounted Host', async () => {
  const screen = await renderReview(undefined, 'partial');
  const { ReviewDetailView } = await import('./ReviewDetailView');
  try {
    await vi.waitFor(() => expect(screen.findByType(ReviewDetailView).props).toMatchObject({
      quality: null, qualityUnavailableReason: 'partial',
      qualityReviewers: expect.arrayContaining([{ reviewerId: 'step-1-reviewer-1', displayName: 'Codex',
        score: 4, rationale: 'Clean backoff with a cap and a give-up path.' }]),
    }));
  } finally {
    await screen.unmount();
  }
});

it('says "No score" for a partial round and names each reviewer under Show all', async () => {
  const screen = await renderReview(undefined, 'partial');
  try {
    await vi.waitFor(() => expect(textOf(screen, 'review-detail:quality-score')).toBe('No score'));
    // Who didn't finish is said once, on the page's notice line, not again beside the score.
    expect(screen.findHostByTestId('review-detail:quality-basis')).toBeNull();
    expect(textOf(screen, 'review-detail:partial')).toContain('Not every reviewer finished');
    await screen.pressByTestIdAsync('review-detail:quality-each');
    expect(textOf(screen, 'review-detail:quality-reviewer:step-1-reviewer-1')).toContain('Codex 4/5');
    // A reviewer without a recorded name gets the generic label, never its positional id.
    expect(textOf(screen, 'review-detail:quality')).not.toContain('step-1-reviewer');
  } finally {
    await screen.unmount();
  }
});
