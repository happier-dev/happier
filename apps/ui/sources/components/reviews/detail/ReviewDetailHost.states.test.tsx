import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import {
  createSessionFilesViewFixture,
  installSessionFilesViewBoundaries,
  prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import {
  buildReviewCommentFixture,
  storePlainReviewCommentFixture,
} from '@/dev/testkit/fixtures/reviewComments';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';

// The Review page's quiet states (U8 R3 B3–B5): what it says with no score, no findings, and a finding it can't show.
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

async function renderReview(
  params: Readonly<{
    reviewId: string;
    state: 'completed' | 'partial';
    comments: readonly ReviewCommentV1[];
  }>,
) {
  fixture = await createSessionFilesViewFixture({
    serverUrl: `https://${params.reviewId}.test`,
    request: async (url) => {
      if (new URL(String(url)).pathname === '/v1/reviews/comments')
        return Response.json({
          items: params.comments.map(storePlainReviewCommentFixture),
          cursor: null,
        });
      return Response.json({}, { status: 404 });
    },
  });
  const artifact: DecryptedArtifact = {
    id: params.reviewId,
    sourceServerId: fixture.scope.serverId,
    title: 'Code review',
    isDecrypted: true,
    header: {
      kind: 'review.v1',
      v: 1,
      reviewId: params.reviewId,
      title: 'Code review',
    },
    body: JSON.stringify({
      v: 1,
      rounds: [
        {
          ordinal: 1,
          state: params.state,
          startedAt: 1,
          finishedAt: 2,
          reviewerIds: ['step-1-reviewer-1'],
          runs: [],
        },
      ],
    }),
    ownerAccountId: 'alice',
    access: 'owner',
    storageMode: 'plain',
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  fixture.artifacts.replaceStoredRow(
    createPlainArtifactHttpFixture(artifact, 'alice'),
  );
  const { ReviewDetailHost } = await import('./ReviewDetailHost');
  return await fixture.render(
    <ReviewDetailHost
      artifact={artifact}
      bodyState="ready"
      onRetry={() => {}}
    />,
  );
}

it('says nothing about a score when no reviewer gave one, and one line when a round found nothing', async () => {
  const screen = await renderReview({
    reviewId: 'nothing-to-fix',
    state: 'partial',
    comments: [],
  });
  const { t } = await import('@/text');
  try {
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('review-detail:findings-empty'),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain(
      t('reviewWalkthrough.detail.findingsEmpty'),
    );
    // "No score" with nothing behind it is not a fact worth a line at rest.
    expect(screen.findHostByTestId('review-detail:quality')).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it('names a finding it cannot show by its place and says why, with its own words and the way to see it', async () => {
  const detailless = buildReviewCommentFixture({
    id: 'detailless-root',
    threadId: 'detailless-root',
    reviewId: 'detailless-review',
    accountId: 'alice',
    state: 'open',
    roundOrdinal: 1,
    findingIdentity: 'd'.repeat(64),
    anchor: { kind: 'line', filePath: 'qa-reviews.ts', line: 3 },
    body: 'Total subtracts each price',
  });
  const screen = await renderReview({
    reviewId: 'detailless-review',
    state: 'completed',
    comments: [detailless],
  });
  const { t } = await import('@/text');
  try {
    const testID = 'review-detail:unavailable-finding:detailless-root';
    await vi.waitFor(() =>
      expect(screen.findHostByTestId(testID)).not.toBeNull(),
    );
    const text = screen.getTextContent();
    expect(text).toContain(
      t('reviewWalkthrough.detail.findingNoDetailsAt', {
        location: 'qa-reviews.ts:3',
      }),
    );
    expect(text).toContain('Total subtracts each price');
    expect(text).not.toContain(
      t('files.reviewComments.durable.contentUnavailable'),
    );
    await screen.pressByTestIdAsync(`${testID}:action`);
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId('review-detail:panel:changes'),
      ).not.toBeNull(),
    );
  } finally {
    await screen.unmount();
  }
});
