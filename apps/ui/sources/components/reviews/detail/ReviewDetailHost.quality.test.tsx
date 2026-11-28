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
function reviewArtifact(serverId: string, state: 'completed' | 'partial', scored = 3): DecryptedArtifact {
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
    body: JSON.stringify({ v: 1, rounds: state === 'partial' ? rounds.map(round => ({ ...round, reviewerIds: round.reviewerIds.slice(0, 2), reviewerQuality: round.reviewerQuality.slice(0, 1) }))
      : rounds.map(round => ({ ...round, reviewerQuality: round.reviewerQuality.slice(0, scored) })) }),
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
  scored = 3,
) {
  fixture = await createSessionFilesViewFixture({
    serverUrl: 'https://review-quality.test',
    settings,
  });
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  return await fixture.render(
    <ReviewDetailHost
      artifact={reviewArtifact(fixture.scope.serverId, state, scored)}
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

it('shows score coverage without a duplicate partial warning (UI refinements 1125)', async () => {
  const screen = await renderReview(undefined, 'partial');
  try {
    await vi.waitFor(() => expect(textOf(screen, 'review-detail:quality-score')).toBe('No overall score'));
    // Coverage belongs beside the aggregate; per-reviewer outcomes belong on the round card.
    expect(textOf(screen, 'review-detail:quality-basis')).toBe('1 of 2 reviewers scored');
    expect(screen.findHostByTestId('review-detail:partial')).toBeNull();
    await screen.pressByTestIdAsync('review-detail:quality-each');
    // The score leads in its own column, then the name, so "Reviewer 1" never runs into "1/5" (REVIEW-PAGE-DELTA-1122 C).
    expect(textOf(screen, 'review-detail:quality-reviewer:step-1-reviewer-1')).toMatch(/^4\/5/);
    expect(textOf(screen, 'review-detail:quality-reviewer:step-1-reviewer-1')).toContain('Codex');
    // A reviewer without a recorded name gets the generic label, never its positional id.
    expect(textOf(screen, 'review-detail:quality')).not.toContain('step-1-reviewer');
  } finally {
    await screen.unmount();
  }
});

it('says how many of the round\'s reviewers scored when not all of them did (DESIGN-REVIEWS-OPUS-1128 C)', async () => {
  const screen = await renderReview(undefined, 'completed', 2);
  try {
    await vi.waitFor(() => expect(textOf(screen, 'review-detail:quality-score')).toBe('Quality 2/5'));
    // "Lowest of 2 reviewers" beside "3 reviewers" read as a miscount: name the round's coverage instead.
    expect(textOf(screen, 'review-detail:quality-basis')).toBe('2 of 3 reviewers scored');
  } finally {
    await screen.unmount();
  }
});
